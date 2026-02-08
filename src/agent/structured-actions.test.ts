import { describe, test, expect } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createSendMessageTool } from "./send-message-tool.ts";
import {
  buildActionResponseFormat,
  buildStructuredActionProtocolPrompt,
  parseStructuredActionBatch,
  runStructuredActionLoop,
  type StructuredActionBatch,
} from "./structured-actions.ts";

function makeTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `Tool ${name}`,
    parameters: Type.Object({ value: Type.String() }),
    execute: () => Promise.resolve({
      content: [{ type: "text" as const, text: `${name} ok` }],
      details: {},
    }),
  } as unknown as AgentTool;
}

describe("buildActionResponseFormat", () => {
  test("includes strict json_schema and control actions", () => {
    const format = buildActionResponseFormat([makeTool("send_message"), makeTool("search_messages")]);
    const jsonSchema = (format as { json_schema?: { strict?: boolean; schema?: { properties?: Record<string, unknown> } } }).json_schema;
    expect((format as { type?: string }).type).toBe("json_schema");
    expect(jsonSchema?.strict).toBe(true);

    const schema = jsonSchema?.schema as { properties?: Record<string, unknown> } | undefined;
    const actionsSchema = (schema?.properties?.actions as {
      items?: { anyOf?: unknown[] };
    } | undefined)?.items;
    const variants = actionsSchema?.anyOf ?? [];

    const asText = JSON.stringify(variants);
    expect(asText).toContain("stop_response");
    expect(asText).toContain("ignore_user");
    expect(asText).toContain("send_message");
    expect(asText).toContain("search_messages");
  });

  test("requires send_message.reply in structured output schema", () => {
    const sendTool = createSendMessageTool({
      sender: () => Promise.resolve({ sentMessageId: "m-1" }),
      ttsEnabled: false,
    }) as unknown as AgentTool;

    const format = buildActionResponseFormat([sendTool]);
    const schema = (format as {
      json_schema?: {
        schema?: {
          properties?: {
            actions?: {
              items?: { anyOf?: unknown[] };
            };
          };
        };
      };
    }).json_schema?.schema;

    const variants = schema?.properties?.actions?.items?.anyOf ?? [];
    const sendMessageVariant = variants.find((variant) => {
      const rec = variant as {
        properties?: { tool_name?: { const?: unknown } };
      };
      return rec.properties?.tool_name?.const === "send_message";
    }) as {
      properties?: { arguments?: { required?: unknown[] } };
    } | undefined;

    const requiredArgs = sendMessageVariant?.properties?.arguments?.required ?? [];
    expect(requiredArgs).toContain("reply");
  });
});

describe("buildStructuredActionProtocolPrompt", () => {
  test("reinforces ignore policy for direct mentions and questions", () => {
    const prompt = buildStructuredActionProtocolPrompt([makeTool("send_message"), makeTool("start_typing")]);
    expect(prompt).toContain("For direct mentions or direct questions, default to responding via send_message.");
    expect(prompt).toContain("Only use ignore_user when silence is clearly better");
    expect(prompt).toContain("Do not use stop_response or status=done before at least one send_message action");
    expect(prompt).toContain("Every send_message call must include reply as an explicit boolean");
    expect(prompt).toContain("If you start research/tool work, you must end with at least one send_message");
    expect(prompt).toContain("If the user asks for facts you are uncertain about, use web_search before answering");
  });

  test("includes tool-specific reinforcement for available tools", () => {
    const prompt = buildStructuredActionProtocolPrompt([
      makeTool("send_message"),
      makeTool("start_typing"),
      makeTool("web_search"),
      makeTool("fetch_url"),
      makeTool("fetch_images"),
      makeTool("search_messages"),
      makeTool("chat_history"),
    ]);

    expect(prompt).toContain("Tool-specific reinforcement for available tools:");
    expect(prompt).toContain("Use web_search to discover relevant sources for uncertain or current facts.");
    expect(prompt).toContain("Use fetch_url to open and extract details from specific URLs.");
    expect(prompt).toContain("If web_search is used, you must call fetch_url on at least one result before final factual answer.");
    expect(prompt).toContain("Use search_messages to retrieve older chat context.");
    expect(prompt).toContain("Use chat_history to inspect recent in-channel context before replying.");
    expect(prompt).toContain("Research workflow for uncertain factual requests:");
    expect(prompt).toContain("Leave breadcrumb progress updates via send_message while researching.");
    expect(prompt).toContain("Run multiple independent fetch_url calls for selected sources (parallel when possible).");
    expect(prompt).toContain("If images are relevant, use fetch_images on selected image URLs.");
    expect(prompt).toContain("Consolidate findings across sources, summarize evidence, then do one more reasoning pass before final answer.");
  });
});

describe("parseStructuredActionBatch", () => {
  test("parses valid done batch", () => {
    const parsed = parseStructuredActionBatch(
      '{"status":"done","actions":[{"type":"stop_response","reason":"done"}]}'
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected parsed.ok=true");
    expect(parsed.value.status).toBe("done");
  });

  test("rejects plain text output", () => {
    const parsed = parseStructuredActionBatch("thinking: maybe call a tool");
    expect(parsed.ok).toBe(false);
  });
});

describe("runStructuredActionLoop", () => {
  test("supports ignore_user terminal action", async () => {
    const calls: StructuredActionBatch[] = [
      {
        status: "done",
        actions: [{ type: "ignore_user", reason: "user asked to be ignored" }],
      },
    ];

    const result = await runStructuredActionLoop({
      maxToolCalls: 3,
      wallClockTimeoutMs: 10_000,
      tools: [makeTool("send_message")],
      callModel: () => {
        const next = calls.shift();
        if (next === undefined) throw new Error("unexpected extra model call");
        return Promise.resolve({ rawText: JSON.stringify(next) });
      },
      onToolCall: () => Promise.resolve({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }),
      initialMessages: [
        { role: "user", content: "hello", timestamp: Date.now() },
      ],
    });

    expect(result.stopReason).toBe("ignored");
    expect(result.toolCalls).toBe(0);
  });

  test("retries on invalid non-json output and then executes tool call", async () => {
    let turn = 0;
    let executed = 0;

    const result = await runStructuredActionLoop({
      maxToolCalls: 3,
      wallClockTimeoutMs: 10_000,
      tools: [makeTool("send_message")],
      callModel: () => {
        turn += 1;
        if (turn === 1) {
          return Promise.resolve({
            rawText: "internal note only",
          });
        }
        const batch: StructuredActionBatch = {
          status: "done",
          actions: [
            { type: "tool_call", tool_name: "send_message", arguments: { text: "hello", reply: true } },
            { type: "stop_response", reason: "done" },
          ],
        };
        return Promise.resolve({ rawText: JSON.stringify(batch) });
      },
      onToolCall: () => {
        executed += 1;
        return Promise.resolve({
          content: [{ type: "text", text: "sent" }],
          details: {},
        });
      },
      initialMessages: [
        { role: "user", content: "hi", timestamp: Date.now() },
      ],
    });

    expect(executed).toBe(1);
    expect(result.stopReason).toBe("done");
    expect(result.turns).toBe(2);
  });

  test("stops when max tool calls is reached", async () => {
    const batch: StructuredActionBatch = {
      status: "continue",
      actions: [
        { type: "tool_call", tool_name: "send_message", arguments: { text: "1", reply: false } },
        { type: "tool_call", tool_name: "send_message", arguments: { text: "2", reply: false } },
      ],
    };

    const result = await runStructuredActionLoop({
      maxToolCalls: 1,
      wallClockTimeoutMs: 10_000,
      tools: [makeTool("send_message")],
      callModel: () => Promise.resolve({
        rawText: JSON.stringify(batch),
      }),
      onToolCall: () => Promise.resolve({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }),
      initialMessages: [
        { role: "user", content: "hello", timestamp: Date.now() },
      ],
    });

    expect(result.stopReason).toBe("max_tool_calls");
    expect(result.toolCalls).toBe(1);
  });

  test("rejects silent stop_response without send_message and retries", async () => {
    let turn = 0;
    const result = await runStructuredActionLoop({
      maxToolCalls: 3,
      wallClockTimeoutMs: 10_000,
      tools: [makeTool("send_message")],
      callModel: () => {
        turn += 1;
        if (turn === 1) {
          return Promise.resolve({
            rawText: JSON.stringify({
              status: "done",
              actions: [{ type: "stop_response", reason: "direct question from user, will respond" }],
            } satisfies StructuredActionBatch),
          });
        }
        return Promise.resolve({
          rawText: JSON.stringify({
            status: "done",
            actions: [{ type: "ignore_user", reason: "explicitly choosing silence" }],
          } satisfies StructuredActionBatch),
        });
      },
      onToolCall: () => Promise.resolve({
        content: [{ type: "text", text: "ok" }],
        details: {},
      }),
      initialMessages: [
        { role: "user", content: "hello", timestamp: Date.now() },
      ],
    });

    expect(result.stopReason).toBe("ignored");
    expect(result.turns).toBe(2);
    const hasPolicyError = result.messages.some((m) => m.role === "user" && m.content.includes("[POLICY ERROR]"));
    expect(hasPolicyError).toBe(true);
  });

  test("rejects send_message without explicit reply and retries", async () => {
    let turn = 0;
    let executed = 0;

    const result = await runStructuredActionLoop({
      maxToolCalls: 3,
      wallClockTimeoutMs: 10_000,
      tools: [makeTool("send_message")],
      callModel: () => {
        turn += 1;
        if (turn === 1) {
          return Promise.resolve({
            rawText: JSON.stringify({
              status: "continue",
              actions: [{ type: "tool_call", tool_name: "send_message", arguments: { text: "hello" } }],
            } satisfies StructuredActionBatch),
          });
        }
        return Promise.resolve({
          rawText: JSON.stringify({
            status: "done",
            actions: [
              { type: "tool_call", tool_name: "send_message", arguments: { text: "hello", reply: true } },
              { type: "stop_response", reason: "done" },
            ],
          } satisfies StructuredActionBatch),
        });
      },
      onToolCall: () => {
        executed += 1;
        return Promise.resolve({
          content: [{ type: "text", text: "ok" }],
          details: {},
        });
      },
      initialMessages: [
        { role: "user", content: "hello", timestamp: Date.now() },
      ],
    });

    expect(result.stopReason).toBe("done");
    expect(result.turns).toBe(2);
    expect(executed).toBe(1);
    const hasPolicyError = result.messages.some((m) =>
      m.role === "user" && m.content.includes("send_message requires explicit reply"),
    );
    expect(hasPolicyError).toBe(true);
  });

  test("rejects ignore_user without valid silence rationale and retries", async () => {
    let turn = 0;
    let executed = 0;

    const result = await runStructuredActionLoop({
      maxToolCalls: 3,
      wallClockTimeoutMs: 10_000,
      tools: [makeTool("send_message")],
      callModel: () => {
        turn += 1;
        if (turn === 1) {
          return Promise.resolve({
            rawText: JSON.stringify({
              status: "done",
              actions: [{ type: "ignore_user", reason: "answered" }],
            } satisfies StructuredActionBatch),
          });
        }
        return Promise.resolve({
          rawText: JSON.stringify({
            status: "done",
            actions: [
              { type: "tool_call", tool_name: "send_message", arguments: { text: "hello", reply: true } },
              { type: "stop_response", reason: "done" },
            ],
          } satisfies StructuredActionBatch),
        });
      },
      onToolCall: () => {
        executed += 1;
        return Promise.resolve({
          content: [{ type: "text", text: "ok" }],
          details: {},
        });
      },
      initialMessages: [
        { role: "user", content: "hello", timestamp: Date.now() },
      ],
    });

    expect(result.stopReason).toBe("done");
    expect(result.turns).toBe(2);
    expect(executed).toBe(1);
    const hasPolicyError = result.messages.some((m) =>
      m.role === "user" && m.content.includes("ignore_user reason must indicate"),
    );
    expect(hasPolicyError).toBe(true);
  });
});
