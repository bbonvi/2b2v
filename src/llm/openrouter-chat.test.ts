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

  test("maps numeric usage.cost into total cost for logs", async () => {
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
          cost: 0.00123,
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

    expect((result.messageForLogs.usage as { cost?: { total?: number } }).cost?.total).toBe(0.00123);

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

  test("includes nested provider metadata error details on non-2xx responses", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({
        error: {
          message: "Provider returned error",
          metadata: {
            raw: JSON.stringify({
              error: {
                code: 400,
                message: "The specified schema produces a constraint that has too many states for serving.",
                status: "INVALID_ARGUMENT",
              },
            }),
          },
        },
      }, 400)
    );

    try {
      await completeOpenRouterChat({
        apiKey: "key",
        model: "google/gemini-3-flash-preview",
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" }],
        baseUrl: "https://example.com",
      }).then(
        () => {
          throw new Error("expected request to fail");
        },
        (error: unknown) => {
          const msg = error instanceof Error ? error.message : String(error);
          expect(msg).toContain("Provider returned error");
          expect(msg).toContain("too many states");
        },
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("surfaces provider error details when OpenRouter returns 200 with error body", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse({
        error: {
          message: "Provider timed out",
          metadata: {
            raw: JSON.stringify({
              error: {
                code: 504,
                message: "Upstream model did not respond in time.",
                status: "DEADLINE_EXCEEDED",
              },
            }),
          },
        },
      }, 200)
    );

    try {
      await completeOpenRouterChat({
        apiKey: "key",
        model: "google/gemini-3-flash-preview",
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" }],
        baseUrl: "https://example.com",
      }).then(
        () => {
          throw new Error("expected request to fail");
        },
        (error: unknown) => {
          const msg = error instanceof Error ? error.message : String(error);
          expect(msg).toContain("Provider timed out");
          expect(msg).toContain("did not respond in time");
        },
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("includes full raw response when choices are missing", async () => {
    const rawPayload = {
      id: "resp_123",
      provider: "google",
      detail: "unexpected provider payload",
    };
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      makeResponse(rawPayload, 200)
    );

    try {
      await completeOpenRouterChat({
        apiKey: "key",
        model: "google/gemini-3-flash-preview",
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" }],
        baseUrl: "https://example.com",
      }).then(
        () => {
          throw new Error("expected request to fail");
        },
        (error: unknown) => {
          const msg = error instanceof Error ? error.message : String(error);
          expect(msg).toContain("OpenRouter response missing choices");
          expect(msg).toContain(JSON.stringify(rawPayload));
        },
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("propagates abort reason when response parsing fails after timeout abort", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("not-json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    );
    const controller = new AbortController();
    const timeoutError = new Error("LLM output timed out after 60000ms");
    timeoutError.name = "ModelOutputTimeoutError";
    controller.abort(timeoutError);

    try {
      await completeOpenRouterChat({
        apiKey: "key",
        model: "google/gemini-3-flash-preview",
        systemPrompt: "system",
        messages: [{ role: "user", content: "hello" }],
        signal: controller.signal,
        baseUrl: "https://example.com",
      }).then(
        () => {
          throw new Error("expected request to fail");
        },
        (error: unknown) => {
          const msg = error instanceof Error ? error.message : String(error);
          expect(msg).toContain("LLM output timed out after 60000ms");
        },
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("normalizes legacy route options and strips unsupported route payload", async () => {
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
      providerParams: {
        route: {
          fallback: false,
          sort: "throughput",
          google: { safetySettings: [{ category: "x", threshold: "y" }] },
        },
      },
      baseUrl: "https://example.com",
    });

    const init = fetchSpy.mock.calls[0]?.[1];
    const bodyRaw = init?.body;
    const bodyText = typeof bodyRaw === "string" ? bodyRaw : "";
    const body = JSON.parse(bodyText) as {
      route?: unknown;
      provider?: { allow_fallbacks?: boolean; sort?: string };
    };

    expect(body.route).toBeUndefined();
    expect(body.provider?.allow_fallbacks).toBe(false);
    expect(body.provider?.sort).toBe("throughput");

    fetchSpy.mockRestore();
  });
});
