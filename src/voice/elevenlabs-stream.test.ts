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

const PRESET: VoicePreset = {
  voiceId: "voice",
  model: "model",
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
});
