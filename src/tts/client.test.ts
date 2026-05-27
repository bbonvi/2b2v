import { describe, test, expect } from "bun:test";
import { createElevenLabsClient, type GenerateSpeechParams, type FetchFn } from "./client.ts";

const testParams: GenerateSpeechParams = {
  text: "Hello world",
  voiceId: "test-voice-id",
  model: "eleven_v3",
  seed: 1,
  applyTextNormalization: "on",
  outputFormat: "mp3_44100_128",
  voiceSettings: {
    stability: 0.8,
    similarityBoost: 0.75,
    speed: 1.1,
    style: 0.1,
    useSpeakerBoost: true,
  },
};

function createMockFetch(
  response: { status: number; body?: ArrayBuffer | null; text?: string; ok?: boolean }
): FetchFn {
  return (_url, _options) =>
    Promise.resolve({
      ok: response.ok ?? (response.status >= 200 && response.status < 300),
      status: response.status,
      arrayBuffer: () => Promise.resolve(response.body ?? new ArrayBuffer(0)),
      text: () => Promise.resolve(response.text ?? ""),
    } as Response);
}

describe("createElevenLabsClient", () => {
  describe("generate", () => {
    test("sends correct request to ElevenLabs API", async () => {
      let capturedUrl: string | URL | Request | undefined;
      let capturedOptions: RequestInit | undefined;

      const mockFetch: FetchFn = (url, options) => {
        capturedUrl = url;
        capturedOptions = options;
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
        } as Response);
      };

      const client = createElevenLabsClient({
        apiKey: "test-api-key",
        fetchFn: mockFetch,
      });

      await client.generate(testParams);

      if (!(capturedUrl instanceof URL)) {
        throw new Error("Expected ElevenLabs request URL");
      }
      expect(capturedUrl.toString()).toBe(
        "https://api.elevenlabs.io/v1/text-to-speech/test-voice-id?output_format=mp3_44100_128"
      );
      expect(capturedOptions?.method).toBe("POST");
      expect(capturedOptions?.headers).toEqual({
        "xi-api-key": "test-api-key",
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      });

      const body = JSON.parse(capturedOptions?.body as string) as Record<string, unknown>;
      expect(body).toEqual({
        text: "Hello world",
        model_id: "eleven_v3",
        seed: 1,
        apply_text_normalization: "on",
        voice_settings: {
          stability: 0.8,
          similarity_boost: 0.75,
          speed: 1.1,
          style: 0.1,
          use_speaker_boost: true,
        },
      });
    });

    test("returns audio buffer on success", async () => {
      const audioData = new Uint8Array([0x49, 0x44, 0x33]).buffer; // ID3 header bytes
      const client = createElevenLabsClient({
        apiKey: "test-key",
        fetchFn: createMockFetch({ status: 200, body: audioData }),
      });

      const result = await client.generate(testParams);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.buffer.length).toBe(3);
        expect(result.contentType).toBe("audio/mpeg");
      }
    });

    test("returns error on 401 Unauthorized", async () => {
      const client = createElevenLabsClient({
        apiKey: "bad-key",
        fetchFn: createMockFetch({ status: 401 }),
      });

      const result = await client.generate(testParams);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Invalid ElevenLabs API key");
      }
    });

    test("returns detailed ElevenLabs error body when available", async () => {
      const client = createElevenLabsClient({
        apiKey: "limited-key",
        fetchFn: createMockFetch({
          status: 401,
          text: JSON.stringify({
            detail: {
              status: "detected_unusual_activity",
              message: "Free Tier usage disabled.",
            },
          }),
        }),
      });

      const result = await client.generate(testParams);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(
          "ElevenLabs API error 401: detected_unusual_activity: Free Tier usage disabled."
        );
      }
    });

    test("returns error on 429 Rate Limit", async () => {
      const client = createElevenLabsClient({
        apiKey: "test-key",
        fetchFn: createMockFetch({ status: 429 }),
      });

      const result = await client.generate(testParams);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("ElevenLabs rate limit exceeded");
      }
    });

    test("returns error on 5xx Server Error", async () => {
      const client = createElevenLabsClient({
        apiKey: "test-key",
        fetchFn: createMockFetch({ status: 503 }),
      });

      const result = await client.generate(testParams);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("ElevenLabs service unavailable");
      }
    });

    test("returns error on other HTTP errors", async () => {
      const client = createElevenLabsClient({
        apiKey: "test-key",
        fetchFn: createMockFetch({ status: 400 }),
      });

      const result = await client.generate(testParams);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("ElevenLabs API error: 400");
      }
    });

    test("returns error on timeout", async () => {
      const slowFetch: FetchFn = (_url, options) => {
        // Wait for abort
        return new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      };

      const client = createElevenLabsClient({
        apiKey: "test-key",
        fetchFn: slowFetch,
        timeoutMs: 10,
      });

      const result = await client.generate(testParams);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Voice generation timed out");
      }
    });

    test("returns error on network failure", async () => {
      const failingFetch: FetchFn = () => Promise.reject(new TypeError("fetch failed"));

      const client = createElevenLabsClient({
        apiKey: "test-key",
        fetchFn: failingFetch,
      });

      const result = await client.generate(testParams);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("Network error during voice generation");
      }
    });

    test("uses default timeout of 30 seconds", async () => {
      let capturedSignal: AbortSignal | undefined;

      const mockFetch: FetchFn = (_url, options) => {
        capturedSignal = options?.signal ?? undefined;
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        } as Response);
      };

      const client = createElevenLabsClient({
        apiKey: "test-key",
        fetchFn: mockFetch,
      });

      await client.generate(testParams);

      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(false);
    });
  });
});
