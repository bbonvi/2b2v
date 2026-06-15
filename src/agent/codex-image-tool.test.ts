import { describe, expect, test } from "bun:test";
import {
  buildCodexDirectImageRequestBody,
  buildCodexHeaders,
  buildCodexImageRequestBody,
  codexImageFailureMessageForAgent,
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
    expect(body.prompt_cache_key).toBe("session-1");
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
  test("adds one-off rewritten-prompt retry guidance for image failures", () => {
    const message = codexImageFailureMessageForAgent(
      "Codex image generation failed: {\"type\":\"image_generation_call\",\"status\":\"failed\"}",
    );

    expect(message).toContain("call codex_generate_image one more time");
    expect(message).toContain("Do not resend the exact same prompt");
    expect(message).toContain("If the rewritten retry also fails, stop retrying");
  });

  test("does not add image retry guidance to unrelated failures", () => {
    expect(codexImageFailureMessageForAgent("OpenAI Codex OAuth credentials are missing.")).toBe(
      "OpenAI Codex OAuth credentials are missing.",
    );
  });
});

describe("buildCodexDirectImageRequestBody", () => {
  test("builds the Codex direct image proxy request", () => {
    expect(buildCodexDirectImageRequestBody({
      prompt: "a polished icon",
    })).toEqual({
      prompt: "a polished icon",
      model: "gpt-image-2",
      n: 1,
      quality: "auto",
      size: "auto",
    });
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
});
