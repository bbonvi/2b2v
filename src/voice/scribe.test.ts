import { describe, expect, test } from "bun:test";
import type { VoiceSttConfig } from "../config/types.ts";
import { ElevenLabsScribeSession } from "./scribe.ts";

type SocketEvent = { code?: number; reason?: string; data?: unknown };

class FakeWebSocket {
  static latest: FakeWebSocket | undefined;
  readonly sent: string[] = [];
  readonly url: string;
  readonly options: unknown;
  private readonly listeners = new Map<string, Array<(event: SocketEvent) => void>>();

  constructor(url: string | URL, options?: unknown) {
    this.url = String(url);
    this.options = options;
    FakeWebSocket.latest = this;
  }

  addEventListener(type: string, listener: (event: SocketEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.emit("close", { code, reason: "" });
  }

  emit(type: string, event: SocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const config = {
  model: "scribe_v2_realtime",
  language: "ru",
  previousText: "2B. Туби.",
  filterBackgroundAudio: true,
  timeoutMs: 1_000,
} as VoiceSttConfig;

describe("ElevenLabsScribeSession", () => {
  test("sends only committed PCM duration and applies previous text once", async () => {
    const original = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    try {
      const session = new ElevenLabsScribeSession("secret", config);
      const socket = FakeWebSocket.latest;
      if (socket === undefined) throw new Error("Expected Scribe socket");
      expect(socket.options).toEqual({ headers: { "xi-api-key": "secret" } });
      expect(new URL(socket.url).searchParams.get("filter_background_audio")).toBe("true");
      socket.emit("message", { data: JSON.stringify({ message_type: "session_started" }) });
      await session.push(Buffer.alloc(3_200));
      const committed = session.commit(Buffer.alloc(1_600));
      await Bun.sleep(0);
      socket.emit("message", {
        data: JSON.stringify({ message_type: "committed_transcript", text: "Туби." }),
      });

      expect(await committed).toEqual({ text: "Туби.", audioMs: 150 });
      const messages = socket.sent.map((value) => JSON.parse(value) as Record<string, unknown>);
      expect(messages[0]?.previous_text).toBe("2B. Туби.");
      expect(messages[1]?.previous_text).toBeUndefined();
      expect(messages[1]?.commit).toBe(true);
      session.close();
    } finally {
      FakeWebSocket.latest = undefined;
      globalThis.WebSocket = original;
    }
  });
});
