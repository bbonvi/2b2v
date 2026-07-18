#!/opt/faster-whisper/bin/python
"""Persistent loopback HTTP service for stateful Silero VAD inference."""

from __future__ import annotations

import argparse
import json
import logging
import re
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import numpy as np
import onnxruntime

SAMPLE_RATE = 16_000
WINDOW_SAMPLES = 512
CONTEXT_SAMPLES = 64
WINDOW_BYTES = WINDOW_SAMPLES * 2
MAX_PCM_BYTES = WINDOW_BYTES * 64
STREAM_ID_PATTERN = re.compile(r"^[A-Za-z0-9:_-]{1,160}$")


@dataclass
class StreamState:
    """Recurrent model tensors belonging to one Discord speaker stream."""

    state: np.ndarray
    context: np.ndarray


class VadService:
    """Own one CPU ONNX session and isolated recurrent state per speaker."""

    def __init__(self, model_path: str) -> None:
        options = onnxruntime.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        self.session = onnxruntime.InferenceSession(
            model_path,
            providers=["CPUExecutionProvider"],
            sess_options=options,
        )
        self.streams: dict[str, StreamState] = {}
        self.lock = threading.Lock()
        logging.info("loaded Silero VAD model path=%s", model_path)

    def infer(self, stream_id: str, payload: bytes) -> list[float]:
        """Score complete 32 ms windows while retaining recurrent stream state."""
        if len(payload) == 0 or len(payload) % WINDOW_BYTES != 0:
            raise ValueError(f"PCM must contain complete {WINDOW_SAMPLES}-sample windows")
        samples = np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768.0
        with self.lock:
            stream = self.streams.get(stream_id)
            if stream is None:
                stream = StreamState(
                    state=np.zeros((2, 1, 128), dtype=np.float32),
                    context=np.zeros((1, CONTEXT_SAMPLES), dtype=np.float32),
                )
                self.streams[stream_id] = stream
            probabilities: list[float] = []
            for offset in range(0, samples.size, WINDOW_SAMPLES):
                window = samples[offset : offset + WINDOW_SAMPLES].reshape(1, WINDOW_SAMPLES)
                model_input = np.concatenate((stream.context, window), axis=1)
                output, next_state = self.session.run(
                    None,
                    {
                        "input": model_input,
                        "state": stream.state,
                        "sr": np.array(SAMPLE_RATE, dtype=np.int64),
                    },
                )
                stream.context = model_input[:, -CONTEXT_SAMPLES:]
                stream.state = next_state
                probabilities.append(float(output.reshape(-1)[0]))
            return probabilities

    def reset(self, stream_id: str) -> None:
        """Discard all recurrent state after a Discord receive stream ends."""
        with self.lock:
            self.streams.pop(stream_id, None)


class VadServer(ThreadingHTTPServer):
    """Loopback server carrying one shared VAD model."""

    daemon_threads = True

    def __init__(self, address: tuple[str, int], service: VadService) -> None:
        super().__init__(address, VadHandler)
        self.service = service


class VadHandler(BaseHTTPRequestHandler):
    """Health, inference, and stream-reset endpoints used by the Bun runtime."""

    server: VadServer

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_error(404)
            return
        self._send_json(200, {"status": "ok"})

    def do_POST(self) -> None:
        if self.path not in ("/inference", "/reset"):
            self.send_error(404)
            return
        stream_id = self.headers.get("X-Stream-ID", "")
        if STREAM_ID_PATTERN.fullmatch(stream_id) is None:
            self._send_json(400, {"error": "A valid X-Stream-ID header is required"})
            return
        if self.path == "/reset":
            self.server.service.reset(stream_id)
            self._send_json(200, {"status": "ok"})
            return
        content_length = self._content_length()
        if content_length is None:
            return
        if content_length > MAX_PCM_BYTES:
            self._send_json(413, {"error": "PCM payload exceeds the service limit"})
            return
        payload = self.rfile.read(content_length)
        try:
            probabilities = self.server.service.infer(stream_id, payload)
        except ValueError as error:
            self._send_json(400, {"error": str(error)})
            return
        except Exception:
            logging.exception("Silero VAD inference failed")
            self._send_json(500, {"error": "Local voice detection failed"})
            return
        self._send_json(200, {"probabilities": probabilities})

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _content_length(self) -> int | None:
        raw_length = self.headers.get("Content-Length")
        try:
            content_length = int(raw_length) if raw_length is not None else -1
        except ValueError:
            content_length = -1
        if content_length < 0:
            self._send_json(400, {"error": "A valid Content-Length header is required"})
            return None
        return content_length

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def parse_args() -> argparse.Namespace:
    """Parse process configuration supplied by the TypeScript adapter."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--model", required=True)
    return parser.parse_args()


def main() -> None:
    """Load the model before advertising readiness, then serve until terminated."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args()
    server = VadServer((args.host, args.port), VadService(args.model))
    logging.info("Silero VAD server ready host=%s port=%d", args.host, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
