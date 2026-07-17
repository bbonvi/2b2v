#!/opt/faster-whisper/bin/python
"""Persistent loopback HTTP service for CPU faster-whisper inference."""

from __future__ import annotations

import argparse
import json
import logging
import math
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import numpy as np
from faster_whisper import WhisperModel

MAX_PCM_BYTES = 16 * 1024 * 1024
INPUT_SAMPLE_RATE = 48_000
INPUT_CHANNELS = 2
OUTPUT_SAMPLE_RATE = 16_000
SAMPLES_PER_OUTPUT = INPUT_SAMPLE_RATE // OUTPUT_SAMPLE_RATE * INPUT_CHANNELS


def decode_discord_pcm(payload: bytes) -> np.ndarray:
    """Downmix 48 kHz stereo signed PCM and box-filter it to 16 kHz mono."""
    samples = np.frombuffer(payload, dtype="<i2")
    usable_samples = samples.size - samples.size % SAMPLES_PER_OUTPUT
    if usable_samples == 0:
        return np.empty(0, dtype=np.float32)
    frames = samples[:usable_samples].reshape(-1, SAMPLES_PER_OUTPUT)
    return frames.mean(axis=1, dtype=np.float32) / 32768.0


class TranscriptionService:
    """Own one loaded CTranslate2 model and serialize inference through it."""

    def __init__(
        self,
        model_path: str,
        language: str,
        initial_prompt: str,
        compute_type: str,
        threads: int,
    ) -> None:
        self.model_path = model_path
        self.language = language
        self.initial_prompt = initial_prompt
        self.lock = threading.Lock()
        started_at = time.monotonic()
        self.model = WhisperModel(
            model_path,
            device="cpu",
            compute_type=compute_type,
            cpu_threads=threads,
            num_workers=1,
            local_files_only=True,
        )
        logging.info(
            "loaded faster-whisper model path=%s compute_type=%s threads=%d duration_ms=%d",
            model_path,
            compute_type,
            threads,
            round((time.monotonic() - started_at) * 1000),
        )

    def transcribe(self, payload: bytes) -> dict[str, str]:
        """Transcribe one finalized Discord utterance without retaining its audio."""
        audio = decode_discord_pcm(payload)
        if audio.size == 0:
            return {"text": "", "language": self.language, "model": self.model_path}

        max_new_tokens = min(160, max(24, math.ceil(audio.size / OUTPUT_SAMPLE_RATE * 10)))
        with self.lock:
            segments, info = self.model.transcribe(
                audio,
                language=self.language,
                task="transcribe",
                beam_size=1,
                best_of=1,
                repetition_penalty=1.1,
                no_repeat_ngram_size=3,
                temperature=[0.0, 0.2, 0.4],
                condition_on_previous_text=False,
                initial_prompt=self.initial_prompt or None,
                without_timestamps=True,
                word_timestamps=False,
                vad_filter=False,
                max_new_tokens=max_new_tokens,
            )
            # A supplied wake-word prompt can otherwise be repeated verbatim for
            # silence, while failed decoding can produce long repetition loops.
            text = " ".join(
                segment.text.strip()
                for segment in segments
                if segment.no_speech_prob < 0.6 and segment.compression_ratio <= 2.4
            ).strip()
        return {
            "text": text,
            "language": info.language or self.language,
            "model": self.model_path,
        }


class VoiceSttServer(ThreadingHTTPServer):
    """Loopback server carrying the shared transcription service."""

    daemon_threads = True

    def __init__(self, address: tuple[str, int], service: TranscriptionService) -> None:
        super().__init__(address, VoiceSttHandler)
        self.service = service


class VoiceSttHandler(BaseHTTPRequestHandler):
    """Minimal health and raw-PCM inference endpoints used by the Bun runtime."""

    server: VoiceSttServer

    def do_GET(self) -> None:
        if self.path != "/health":
            self.send_error(404)
            return
        self._send_json(200, {"status": "ok"})

    def do_POST(self) -> None:
        if self.path != "/inference":
            self.send_error(404)
            return
        content_length = self._content_length()
        if content_length is None:
            return
        if content_length > MAX_PCM_BYTES:
            self._send_json(413, {"error": "PCM payload exceeds the service limit"})
            return
        payload = self.rfile.read(content_length)
        started_at = time.monotonic()
        try:
            result = self.server.service.transcribe(payload)
        except Exception:
            logging.exception("faster-whisper inference failed")
            self._send_json(500, {"error": "Local voice transcription failed"})
            return
        logging.info(
            "transcribed audio_ms=%d characters=%d duration_ms=%d",
            round(len(payload) / (INPUT_SAMPLE_RATE * INPUT_CHANNELS * 2) * 1000),
            len(result["text"]),
            round((time.monotonic() - started_at) * 1000),
        )
        self._send_json(200, result)

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

    def _send_json(self, status: int, payload: dict[str, str]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def parse_args() -> argparse.Namespace:
    """Parse the process configuration supplied by the TypeScript adapter."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--language", required=True)
    parser.add_argument("--prompt", default="")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--threads", type=int, required=True)
    return parser.parse_args()


def main() -> None:
    """Load the model before advertising readiness, then serve until terminated."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args()
    service = TranscriptionService(
        args.model,
        args.language,
        args.prompt,
        args.compute_type,
        args.threads,
    )
    server = VoiceSttServer((args.host, args.port), service)
    logging.info("faster-whisper server ready host=%s port=%d", args.host, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
