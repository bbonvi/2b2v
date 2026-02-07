import { describe, test, expect, spyOn } from "bun:test";
import { completeOpenRouterChat } from "./openrouter-chat.ts";

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("completeOpenRouterChat", () => {
  test("includes response_format in outgoing payload", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({
        model: "m",
        choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );

    await completeOpenRouterChat({
      apiKey: "key",
      model: "moonshotai/kimi-k2.5",
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      responseFormat: { type: "json_schema", json_schema: { name: "x", strict: true, schema: { type: "object" } } },
      baseUrl: "https://example.com",
    });

    const init = fetchSpy.mock.calls[0]?.[1];
    const bodyRaw = init?.body;
    const bodyText = typeof bodyRaw === "string" ? bodyRaw : "";
    const body = JSON.parse(bodyText) as { response_format?: { type?: string } };
    expect(body.response_format?.type).toBe("json_schema");

    fetchSpy.mockRestore();
  });

  test("normalizes content and usage for logs", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({
        model: "openai/gpt-4o-mini",
        choices: [
          {
            message: { content: [{ type: "text", text: "{\"status\":\"done\"}" }] },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          cost: { total: 0.001 },
        },
      })
    );

    const result = await completeOpenRouterChat({
      apiKey: "key",
      model: "openai/gpt-4o-mini",
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      baseUrl: "https://example.com",
    });

    expect(result.text).toBe('{"status":"done"}');
    expect(result.messageForLogs.role).toBe("assistant");
    expect((result.messageForLogs.usage as { input?: number }).input).toBe(10);
    expect((result.messageForLogs.usage as { output?: number }).output).toBe(5);

    fetchSpy.mockRestore();
  });

  test("throws descriptive error on non-2xx responses", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({ error: { message: "bad request" } }, 400)
    );

    await completeOpenRouterChat({
      apiKey: "key",
      model: "moonshotai/kimi-k2.5",
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello" }],
      baseUrl: "https://example.com",
    }).then(
      () => {
        throw new Error("expected request to fail");
      },
      (error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        expect(msg).toContain("bad request");
      },
    );

    fetchSpy.mockRestore();
  });
});
