import { describe, test, expect } from "bun:test";
import { createElevenLabsClient, type GenerateSpeechParams, type FetchFn } from "./client.ts";

const testParams: GenerateSpeechParams = {
  text: "Hello world",
  voiceId: "test-voice-id",
  model: "eleven_flash_v2_5",
  voiceSettings: {
    stability: 0.8,
    similarityBoost: 0.75,
    speed: 1.1,
  },
};

function createMockFetch(
  response: { status: number; body?: ArrayBuffer | null; ok?: boolean }
): FetchFn {
  return async (_url, _options) => {
    return {
      ok: response.ok ?? (response.status >= 200 && response.status < 300),
      status: response.status,
      arrayBuffer: async () => response.body ?? new ArrayBuffer(0),
    } as Response;
  };
}

describe("createElevenLabsClient", () => {
  describe("generate", () => {
    test("sends correct request to ElevenLabs API", async () => {
      let capturedUrl: string | URL | Request | undefined;
      let capturedOptions: RequestInit | undefined;

      const mockFetch: FetchFn = async (url, options) => {
        capturedUrl = url;
        capturedOptions = options;
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(100),
        } as Response;
      };

      const client = createElevenLabsClient({
        apiKey: "test-api-key",
        fetchFn: mockFetch,
      });

      await client.generate(testParams);

      expect(capturedUrl).toBe(
        "https://api.elevenlabs.io/v1/text-to-speech/test-voice-id"
      );
      expect(capturedOptions?.method).toBe("POST");
      expect(capturedOptions?.headers).toEqual({
        "xi-api-key": "test-api-key",
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      });

      const body = JSON.parse(capturedOptions?.body as string);
      expect(body).toEqual({
        text: "Hello world",
        model_id: "eleven_flash_v2_5",
        voice_settings: {
          stability: 0.8,
          similarity_boost: 0.75,
          speed: 1.1,
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
      const slowFetch: FetchFn = async (_url, options) => {
        // Wait for abort
        await new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
        throw new Error("Should not reach here");
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
      const failingFetch: FetchFn = async () => {
        throw new TypeError("fetch failed");
      };

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

      const mockFetch: FetchFn = async (_url, options) => {
        capturedSignal = options?.signal ?? undefined;
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(0),
        } as Response;
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
