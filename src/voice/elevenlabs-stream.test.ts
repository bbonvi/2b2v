import { describe, expect, test } from "bun:test";
import type { VoicePreset } from "../tts/types.ts";
import { ElevenLabsVoiceStream } from "./elevenlabs-stream.ts";

type FakeSocketEvent = {
  code?: number;
  reason?: string;
  data?: unknown;
};

class AbortErrorWebSocket {
  private readonly listeners = new Map<string, Array<(event: FakeSocketEvent) => void>>();

  addEventListener(type: string, listener: (event: FakeSocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(_data: string): void {}

  close(): void {
    this.emit("error", {});
    this.emit("close", { code: 1006, reason: "aborted before opening" });
  }

  private emit(type: string, event: FakeSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class AlignmentWebSocket {
  static latest: AlignmentWebSocket | undefined;
  readonly url: string;
  private readonly listeners = new Map<string, Array<(event: FakeSocketEvent) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    AlignmentWebSocket.latest = this;
  }

  addEventListener(type: string, listener: (event: FakeSocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(_data: string): void {}

  close(): void {
    this.emit("close", { code: 1000, reason: "closed" });
  }

  emit(type: string, event: FakeSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const PRESET: VoicePreset = {
  voiceId: "voice",
  model: "model",
  languageCode: "ru",
  speed: 1,
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  useSpeakerBoost: false,
};

describe("ElevenLabsVoiceStream", () => {
  test("treats an error emitted by intentional pre-open abort as normal closure", async () => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = AbortErrorWebSocket as unknown as typeof WebSocket;
    try {
      const stream = new ElevenLabsVoiceStream("token", PRESET);
      stream.abort();
      await stream.finish();
      expect(stream.metrics().audioBytes).toBe(0);
    } finally {
      globalThis.WebSocket = original;
    }
  });

  test("maps submitted character boundaries onto synchronized playback time", () => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = AlignmentWebSocket as unknown as typeof WebSocket;
    try {
      const stream = new ElevenLabsVoiceStream("token", PRESET);
      const socket = AlignmentWebSocket.latest;
      if (socket === undefined) throw new Error("Expected alignment socket");
      expect(new URL(socket.url).searchParams.get("language_code")).toBe("ru");
      socket.emit("open", {});
      socket.emit("message", {
        data: JSON.stringify({
          normalizedAlignment: {
            chars: ["O", "K", "."],
            charStartTimesMs: [0, 100, 200],
            charDurationsMs: [100, 100, 100],
          },
        }),
      });

      expect(stream.alignedEndMsAtCharacterOffset(2)).toBe(200);
      expect(stream.alignedEndMsAtCharacterOffset(4)).toBeUndefined();
      stream.abort();
    } finally {
      AlignmentWebSocket.latest = undefined;
      globalThis.WebSocket = original;
    }
  });
});
