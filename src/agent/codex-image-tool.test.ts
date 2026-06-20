import { describe, expect, test } from "bun:test";
import {
  buildCodexDirectImageEditRequestBody,
  buildCodexDirectImageRequestBody,
  buildCodexHeaders,
  buildCodexImageRequestBody,
  buildCodexResponsesImageHeaders,
  calculate4kImageSize,
  codexImageFailureMessageForAgent,
  createCodexGenerateImageTool,
  infer4kAspectRatio,
  parseCodexDirectImageResponse,
  parseCodexImageSse,
} from "./codex-image-tool.ts";

function sseResponse(events: unknown[]): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("parseCodexImageSse", () => {
  test("waits past image generation items that do not yet include result data", async () => {
    const parsed = await parseCodexImageSse(sseResponse([
      {
        type: "response.output_item.done",
        item: {
          type: "image_generation_call",
          id: "ig_1",
          status: "generating",
        },
      },
      {
        type: "response.image_generation_call.completed",
        item: {
          type: "image_generation_call",
          id: "ig_1",
          status: "completed",
          result: "ZmFrZS1pbWFnZQ==",
          revised_prompt: "a generated image",
        },
      },
    ]));

    expect(parsed.image).toEqual({
      id: "ig_1",
      status: "completed",
      result: "ZmFrZS1pbWFnZQ==",
      revisedPrompt: "a generated image",
    });
  });

  test("keeps the latest partial image as a fallback", async () => {
    const parsed = await parseCodexImageSse(sseResponse([
      {
        type: "response.image_generation_call.partial_image",
        partial_image_b64: "cHJldmlldw==",
      },
      {
        type: "response.output_item.done",
        item: {
          type: "image_generation_call",
          id: "ig_1",
          status: "completed",
        },
      },
    ]));

    expect(parsed.image).toBeUndefined();
    expect(parsed.lastPartialImage).toBe("cHJldmlldw==");
  });

  test("records failed image generation items without aborting the stream parse", async () => {
    const parsed = await parseCodexImageSse(sseResponse([
      {
        type: "response.output_item.done",
        item: {
          type: "image_generation_call",
          id: "ig_1",
          status: "failed",
        },
      },
      {
        type: "response.output_text.delta",
        delta: "Generation was unavailable.",
      },
    ]));

    expect(parsed.image).toBeUndefined();
    expect(parsed.failure).toBe("{\"type\":\"image_generation_call\",\"id\":\"ig_1\",\"status\":\"failed\"}");
    expect(parsed.failureEvent).toEqual({
      type: "response.output_item.done",
      item: {
        type: "image_generation_call",
        id: "ig_1",
        status: "failed",
      },
    });
    expect(parsed.text.join("")).toBe("Generation was unavailable.");
  });

  test("redacts image payloads from diagnostic events", async () => {
    const parsed = await parseCodexImageSse(sseResponse([
      {
        type: "response.output_item.done",
        item: {
          type: "image_generation_call",
          id: "ig_1",
          status: "failed",
          result: "base64-image",
        },
      },
      {
        type: "response.image_generation_call.partial_image",
        partial_image_b64: "partial-base64-image",
      },
    ]));

    expect(parsed.diagnosticEvents).toEqual([
      {
        type: "response.output_item.done",
        item: {
          type: "image_generation_call",
          id: "ig_1",
          status: "failed",
          result: "[redacted]",
        },
      },
      {
        type: "response.image_generation_call.partial_image",
        partial_image_b64: "[redacted]",
      },
    ]);
  });
});

describe("buildCodexImageRequestBody", () => {
  test("sends an OpenClaw-style image-generation request without chat style guidance", () => {
    const body = buildCodexImageRequestBody({
      model: "gpt-5.5",
      prompt: "selfie of a futuristic android at a desk",
      outputFormat: "png",
      sessionId: "session-1",
    });

    expect(body.model).toBe("gpt-5.5");
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.include).toBeUndefined();
    expect(body.tools).toEqual([{
      type: "image_generation",
      model: "gpt-image-2",
      action: "generate",
      output_format: "png",
      moderation: "low",
      quality: "auto",
      size: "auto",
    }]);
    expect(body.tool_choice).toEqual({ type: "image_generation" });
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.text).toEqual({ verbosity: "low" });
    expect(body.instructions).toBe("You are an image generation assistant.");
    const input = body.input as Array<{ content: Array<{ text: string }> }>;
    expect(input[0]?.content[0]?.text).toBe("selfie of a futuristic android at a desk");
    expect(input[0]?.content[0]?.text).not.toContain("Discord");
    expect(input[0]?.content[0]?.text).not.toContain("style guidance");
  });

  test("omits prompt cache keys from Codex image requests", () => {
    const body = buildCodexImageRequestBody({
      model: "gpt-5.5",
      prompt: "a cat",
      outputFormat: "png",
      sessionId: "2b2v-image-job:1234567890123456789:1234567890123456789:img-abcdef",
    });

    expect(body.prompt_cache_key).toBeUndefined();
  });

  test("uses configured image generation quality", () => {
    const body = buildCodexImageRequestBody({
      model: "gpt-5.5",
      prompt: "a cat",
      outputFormat: "png",
      imageGenerationQuality: "high",
    });

    expect(body.tools).toEqual([{
      type: "image_generation",
      model: "gpt-image-2",
      action: "generate",
      output_format: "png",
      moderation: "low",
      quality: "high",
      size: "auto",
    }]);
  });

  test("includes chat reference images as Responses image inputs", () => {
    const body = buildCodexImageRequestBody({
      model: "gpt-5.5",
      prompt: "turn this into a rainy noir poster",
      outputFormat: "webp",
      referenceImages: [{
        id: 42,
        data: "aW1hZ2UtZGF0YQ==",
        mimeType: "image/jpeg",
        width: 800,
        height: 600,
      }],
    });

    expect(body.tools).toEqual([{
      type: "image_generation",
      model: "gpt-image-2",
      action: "auto",
      output_format: "webp",
      moderation: "low",
      quality: "auto",
      size: "auto",
    }]);
    const input = body.input as Array<{ content: Array<Record<string, unknown>> }>;
    expect(input[0]?.content).toEqual([
      {
        type: "input_text",
        text: [
          "turn this into a rainy noir poster",
          "",
          "Reference images from chat are attached below:",
          "Reference 1: Chat ImageID 42, 800x600, image/jpeg.",
        ].join("\n"),
      },
      {
        type: "input_image",
        detail: "auto",
        image_url: "data:image/jpeg;base64,aW1hZ2UtZGF0YQ==",
      },
    ]);
  });
});

describe("codexImageFailureMessageForAgent", () => {
  test("does not add retry guidance to image failures", () => {
    const message = "Codex image generation failed: {\"type\":\"image_generation_call\",\"status\":\"failed\"}";

    expect(codexImageFailureMessageForAgent(message)).toBe(message);
  });

  test("leaves unrelated failures unchanged", () => {
    expect(codexImageFailureMessageForAgent("OpenAI Codex OAuth credentials are missing.")).toBe(
      "OpenAI Codex OAuth credentials are missing.",
    );
  });
});

describe("buildCodexDirectImageRequestBody", () => {
  test("builds the Codex direct image proxy request", () => {
    expect(buildCodexDirectImageRequestBody({
      prompt: "a polished icon",
      imageGenerationQuality: "high",
      size: "2880x2880",
      outputFormat: "webp",
    })).toEqual({
      prompt: "a polished icon",
      model: "gpt-image-2",
      n: 1,
      quality: "high",
      size: "2880x2880",
      output_format: "webp",
    });
  });
});

describe("buildCodexDirectImageEditRequestBody", () => {
  test("builds the JSON edit request with data URL reference images", () => {
    expect(buildCodexDirectImageEditRequestBody({
      prompt: "make this a print-resolution poster",
      imageGenerationQuality: "high",
      size: "3520x2336",
      outputFormat: "webp",
      referenceImages: [{
        id: 7,
        data: "aW1hZ2U=",
        mimeType: "image/webp",
        width: 1200,
        height: 800,
      }],
    })).toEqual({
      prompt: "make this a print-resolution poster",
      model: "gpt-image-2",
      n: 1,
      quality: "high",
      size: "3520x2336",
      output_format: "webp",
      images: [{ image_url: "data:image/webp;base64,aW1hZ2U=" }],
    });
  });
});

describe("4K image sizing", () => {
  test("infers conservative prompt aspects", () => {
    expect(infer4kAspectRatio("cinematic wallpaper of neon streets")).toEqual({ width: 16, height: 9 });
    expect(infer4kAspectRatio("vertical phone portrait selfie")).toEqual({ width: 9, height: 16 });
    expect(infer4kAspectRatio("profile avatar icon")).toEqual({ width: 1, height: 1 });
    expect(infer4kAspectRatio("fantasy poster key art")).toEqual({ width: 3, height: 2 });
    expect(infer4kAspectRatio("a cozy cabin")).toEqual({ width: 1, height: 1 });
  });

  test("calculates valid maximum 4K-ish sizes", () => {
    expect(calculate4kImageSize({ width: 16, height: 9 })).toEqual({ width: 3840, height: 2160 });
    expect(calculate4kImageSize({ width: 9, height: 16 })).toEqual({ width: 2160, height: 3840 });
    expect(calculate4kImageSize({ width: 1, height: 1 })).toEqual({ width: 2880, height: 2880 });
    expect(calculate4kImageSize({ width: 3, height: 2 })).toEqual({ width: 3520, height: 2336 });
  });
});

describe("createCodexGenerateImageTool", () => {
  test("defaults async image jobs to WebP and non-4K", async () => {
    let observed: { outputFormat: string; is4k: boolean } | undefined;
    const tool = createCodexGenerateImageTool({
      codexAuthPath: "unused",
      model: "gpt-5.5",
      imageReadMaxPerCall: 2,
      imageGenerationQuality: "auto",
      getImageById: () => null,
      readFile: () => null,
      onGeneratedImage: () => {},
      enqueueImageJob: (input) => {
        observed = { outputFormat: input.outputFormat, is4k: input.is4k };
        return {
          created: true,
          reason: "created",
          job: {
            id: "img-1",
            kind: "image_generation",
            guildId: "g1",
            channelId: "c1",
            deliveryGuildId: "g1",
            deliveryChannelId: "c1",
            requesterId: "u1",
            requesterUsername: "alice",
            sourceMessageId: "m1",
            sourceQuote: "make an image",
            status: "queued",
            createdAt: 1,
            input,
            replacementCount: 0,
          },
        };
      },
    });

    const result = await tool.execute("call-1", { prompt: "a blue house" });

    expect(result.details).toMatchObject({
      asyncJobId: "img-1",
      asyncJobCreated: true,
      is4k: false,
    });
    expect(observed).toEqual({ outputFormat: "webp", is4k: false });
  });

  test("propagates explicit 4K async job requests", async () => {
    let observed: { outputFormat: string; is4k: boolean } | undefined;
    const tool = createCodexGenerateImageTool({
      codexAuthPath: "unused",
      model: "gpt-5.5",
      imageReadMaxPerCall: 2,
      imageGenerationQuality: "auto",
      getImageById: () => null,
      readFile: () => null,
      onGeneratedImage: () => {},
      enqueueImageJob: (input) => {
        observed = { outputFormat: input.outputFormat, is4k: input.is4k };
        return {
          created: true,
          reason: "created",
          job: {
            id: "img-1",
            kind: "image_generation",
            guildId: "g1",
            channelId: "c1",
            deliveryGuildId: "g1",
            deliveryChannelId: "c1",
            requesterId: "u1",
            requesterUsername: "alice",
            sourceMessageId: "m1",
            sourceQuote: "make an image",
            status: "queued",
            createdAt: 1,
            input,
            replacementCount: 0,
          },
        };
      },
    });

    await tool.execute("call-1", { prompt: "a blue house", "4k": true });

    expect(observed).toEqual({ outputFormat: "webp", is4k: true });
  });
});

describe("parseCodexDirectImageResponse", () => {
  test("extracts the first base64 image from the direct image response", () => {
    const parsed = parseCodexDirectImageResponse({
      created: 1778832973,
      data: [{ b64_json: "ZmFrZS1pbWFnZQ==", revised_prompt: "a polished icon" }],
      usage: { total_tokens: 12 },
    });

    expect(parsed.image).toEqual({
      id: "image_generation_direct",
      status: "completed",
      result: "ZmFrZS1pbWFnZQ==",
      revisedPrompt: "a polished icon",
    });
    expect(parsed.usage).toEqual({ total_tokens: 12 });
    expect(parsed.diagnosticEvents).toEqual([{
      created: 1778832973,
      data: [{ b64_json: "[redacted]", revised_prompt: "a polished icon" }],
      usage: { total_tokens: 12 },
    }]);
  });

  test("throws when the direct image response has no image data", () => {
    expect(() => parseCodexDirectImageResponse({ data: [] })).toThrow("Codex direct image generation returned no image data.");
  });
});

describe("buildCodexHeaders", () => {
  test("mirrors the pi-ai Codex adapter envelope", () => {
    const headers = buildCodexHeaders({
      token: "token",
      accountId: "account-1",
      sessionId: "session-1",
    });

    expect(headers.Authorization).toBe("Bearer token");
    expect(headers["chatgpt-account-id"]).toBe("account-1");
    expect(headers["OpenAI-Beta"]).toBe("responses=experimental");
    expect(headers.originator).toBe("pi");
    expect(headers["User-Agent"]?.startsWith("pi (")).toBe(true);
    expect(headers.session_id).toBe("session-1");
    expect(headers.accept).toBe("text/event-stream");
    expect(headers["content-type"]).toBe("application/json");
  });

  test("can build JSON headers for the direct image route", () => {
    const headers = buildCodexHeaders({
      token: "token",
      accountId: "account-1",
      accept: "application/json",
    });

    expect(headers.accept).toBe("application/json");
    expect(headers.session_id).toBeUndefined();
  });

  test("responses image route never sends session affinity headers", () => {
    const headers = buildCodexResponsesImageHeaders({
      token: "token",
      accountId: "account-1",
    });

    expect(headers.session_id).toBeUndefined();
    expect(headers.accept).toBe("text/event-stream");
  });
});
