import { describe, test, expect } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createSendMessageTool } from "./send-message-tool.ts";
import { resolvePromptPolicy, type ResolvedPromptPolicy } from "./prompt-policy.ts";
import {
  buildActionResponseFormat,
  buildStructuredActionProtocolPrompt,
  parseStructuredActionBatch,
  runStructuredActionLoop,
  type StructuredLoopEvent,
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
    expect(asText).toContain("tool_call");
    expect(asText).toContain("start_typing");
    expect(asText).toContain("persona_turn");
    expect(asText).toContain("stop_response");
    expect(asText).toContain("ignore_user");
  });

  test("keeps tool_call arguments shallow and allows tool_name as plain string", () => {
    const sendTool = createSendMessageTool({
      sender: () => Promise.resolve({ sentMessageId: "m-1" }),
      ttsEnabled: false,
    }) as unknown as AgentTool;

    const format = buildActionResponseFormat([sendTool]);
    const actionsSchema = (format as {
      json_schema?: {
        schema?: {
          properties?: {
            actions?: {
              items?: {
                anyOf?: Array<{
                  required?: string[];
                  properties?: {
                    type?: { const?: string };
                    tool_name?: { enum?: string[]; type?: string; minLength?: number };
                    arguments?: { type?: string; additionalProperties?: boolean };
                  };
                }>;
              };
            };
          };
        };
      };
    }).json_schema?.schema?.properties?.actions;

    const variants = actionsSchema?.items?.anyOf ?? [];
    const toolCallVariant = variants.find((variant) => variant.properties?.type?.const === "tool_call");
    const required = toolCallVariant?.required ?? [];
    expect(required.includes("type")).toBe(true);
    expect(required.includes("tool_name")).toBe(true);
    expect(required.includes("arguments")).toBe(true);
    expect(toolCallVariant?.properties?.tool_name).toEqual({ type: "string", minLength: 1 });
    expect(toolCallVariant?.properties?.arguments).toEqual({
      type: "object",
      additionalProperties: true,
    });
  });
});

describe("buildStructuredActionProtocolPrompt", () => {
  test("injects shared reinforcement rules from centralized policy", () => {
    const tools = [makeTool("send_message"), makeTool("start_typing")];
    const prompt = buildStructuredActionProtocolPrompt(tools);
    const policy = resolvePromptPolicy(new Set(tools.map((tool) => tool.name)));

    expect(policy.sharedRules.map((rule) => rule.id)).toContain("direct_mentions_default_persona_turn");
    expect(policy.sharedRules.map((rule) => rule.id)).toContain("ignore_user_only_when_silence_is_better");
    expect(policy.sharedRules.map((rule) => rule.id)).toContain("persona_turn_requires_reply_boolean");
    expect(policy.sharedRules.map((rule) => rule.id)).toContain("research_requires_final_persona_turn");

    for (const rule of policy.sharedRules) {
      expect(prompt).toContain(rule.text);
    }
    expect(prompt).toContain("Do not use stop_response or status=done before at least one persona_turn action");
  });

  test("includes selected tool and research workflow reinforcement from policy", () => {
    const tools = [
      makeTool("send_message"),
      makeTool("start_typing"),
      makeTool("web_search"),
      makeTool("fetch_url"),
      makeTool("fetch_images"),
      makeTool("search_messages"),
      makeTool("chat_history"),
    ];
    const prompt = buildStructuredActionProtocolPrompt(tools);
    const policy = resolvePromptPolicy(new Set(tools.map((tool) => tool.name)));

    expect(prompt).toContain("Tool-specific reinforcement for available tools:");
    expect(policy.toolRules.map((rule) => rule.id)).toContain("tool_web_search_discover_sources");
    expect(policy.toolRules.map((rule) => rule.id)).toContain("tool_fetch_url_extract_details");
    expect(policy.toolRules.map((rule) => rule.id)).toContain("tool_web_search_requires_fetch_url");
    expect(policy.toolRules.map((rule) => rule.id)).toContain("tool_search_messages_retrieve_older_context");
    expect(policy.toolRules.map((rule) => rule.id)).toContain("tool_chat_history_recent_context");
    expect(policy.researchWorkflowRules.map((rule) => rule.id)).toContain("research_workflow_title");
    expect(policy.researchWorkflowRules.map((rule) => rule.id)).toContain("research_workflow_breadcrumb_updates");
    expect(policy.researchWorkflowRules.map((rule) => rule.id)).toContain("research_workflow_parallel_fetch");
    expect(policy.researchWorkflowRules.map((rule) => rule.id)).toContain("research_workflow_optional_images");
    expect(policy.researchWorkflowRules.map((rule) => rule.id)).toContain("research_workflow_consolidate_and_reason");

    for (const rule of policy.toolRules) {
      expect(prompt).toContain(rule.text);
    }
    for (const rule of policy.researchWorkflowRules) {
      expect(prompt).toContain(rule.text);
    }
  });

  test("uses injected resolved policy and excludes late-only rules", () => {
    const injectedPolicy: ResolvedPromptPolicy = {
      sharedRules: [{ id: "shared", text: "shared injected rule" }],
      lateOnlyRules: [{ id: "late-only", text: "late-only injected rule" }],
      toolRules: [{ id: "tool", text: "tool injected rule" }],
      researchWorkflowRules: [{ id: "research", text: "research injected rule" }],
    };

    const prompt = buildStructuredActionProtocolPrompt([makeTool("send_message")], injectedPolicy);

    expect(prompt).toContain("shared injected rule");
    expect(prompt).toContain("tool injected rule");
    expect(prompt).toContain("research injected rule");
    expect(prompt).not.toContain("late-only injected rule");
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

  test("parses legacy shorthand start_typing action", () => {
    const parsed = parseStructuredActionBatch(
      '{"type":"start_typing"}'
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected parsed.ok=true");
    expect(parsed.value.status).toBe("continue");
    expect(parsed.value.actions[0]?.type).toBe("start_typing");
  });

  test("accepts persona_turn content but leaves text generation to runtime persona", () => {
    const parsed = parseStructuredActionBatch(
      '{"status":"done","actions":[{"type":"persona_turn","kind":"final","reply":true,"content":"hello"}]}'
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("expected parsed.ok=true");
    expect(parsed.value.actions[0]).toEqual({
      type: "persona_turn",
      kind: "final",
      reply: true,
      content: "hello",
    });
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
      llmOutputTimeoutMs: 2_000,
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

  test("accepts ignore_user for sign-off phrasing without policy retry", async () => {
    let turn = 0;
    const result = await runStructuredActionLoop({
      maxToolCalls: 3,
      wallClockTimeoutMs: 10_000,
      llmOutputTimeoutMs: 2_000,
      tools: [makeTool("send_message")],
      callModel: () => {
        turn += 1;
        return Promise.resolve({
          rawText: JSON.stringify({
            status: "done",
            actions: [{
              type: "ignore_user",
              reason: "user signed off, wait for next actionable message",
            }],
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
    expect(result.turns).toBe(1);
    const hasPolicyError = result.messages.some((m) => m.role === "user" && m.content.includes("[POLICY ERROR]"));
    expect(hasPolicyError).toBe(false);
    expect(turn).toBe(1);
  });

  test("retries on invalid non-json output and then executes tool call", async () => {
    let turn = 0;
    let executed = 0;

    const result = await runStructuredActionLoop({
      maxToolCalls: 3,
      wallClockTimeoutMs: 10_000,
      llmOutputTimeoutMs: 2_000,
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
      llmOutputTimeoutMs: 2_000,
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

  test("executes shorthand start_typing action through the matching tool", async () => {
    let executed = 0;
    const startTypingTool = {
      name: "start_typing",
      label: "start_typing",
      description: "Start typing",
      parameters: Type.Object({}),
      execute: (_id: string, args: Record<string, unknown>) => {
        executed += 1;
        expect(args).toEqual({});
        return Promise.resolve({
          content: [{ type: "text" as const, text: "typing" }],
          details: {},
        });
      },
    } as unknown as AgentTool;

    const result = await runStructuredActionLoop({
      maxToolCalls: 3,
      wallClockTimeoutMs: 10_000,
      llmOutputTimeoutMs: 2_000,
      tools: [startTypingTool],
      callModel: () => Promise.resolve({
        rawText: JSON.stringify({
          status: "done",
          actions: [
            { type: "start_typing" },
            { type: "ignore_user", reason: "typing only compatibility path" },
          ],
        } satisfies StructuredActionBatch),
      }),
      initialMessages: [
        { role: "user", content: "hello", timestamp: Date.now() },
      ],
    });

    expect(result.stopReason).toBe("ignored");
    expect(result.toolCalls).toBe(1);
    expect(executed).toBe(1);
    expect(result.messages.some((message) => message.content.includes("[TOOL RESULT] start_typing"))).toBe(true);
  });

  test("persona_turn receives transformed model context and prior same-batch tool results", async () => {
    let personaMessages: string[] = [];
    const result = await runStructuredActionLoop({
      maxToolCalls: 3,
      wallClockTimeoutMs: 10_000,
      llmOutputTimeoutMs: 2_000,
      tools: [makeTool("search_messages")],
      callModel: (messages) => Promise.resolve({
        rawText: JSON.stringify({
          status: "done",
          actions: [
            { type: "tool_call", tool_name: "search_messages", arguments: { value: "x" } },
            { type: "persona_turn", kind: "final", reply: true },
            { type: "stop_response", reason: "done" },
          ],
        } satisfies StructuredActionBatch),
        actionContextMessages: [
          ...messages,
          { role: "user", content: "[CHANNEL UPDATE] follow-up", timestamp: Date.now() },
        ],
      }),
      onToolCall: () => Promise.resolve({
        content: [{ type: "text", text: "search result" }],
        details: {},
      }),
      onPersonaTurn: (_action, _actionId, messages) => {
        personaMessages = messages.map((message) => message.content);
        return Promise.resolve({
          content: [{ type: "text", text: "sent" }],
          details: {},
        });
      },
      initialMessages: [
        { role: "user", content: "hello", timestamp: Date.now() },
      ],
    });

    expect(result.stopReason).toBe("done");
    expect(personaMessages.some((content) => content.includes("[CHANNEL UPDATE] follow-up"))).toBe(true);
    expect(personaMessages.some((content) => content.includes("search result"))).toBe(true);
  });

  test("rejects silent stop_response without send_message and retries", async () => {
    let turn = 0;
    const result = await runStructuredActionLoop({
      maxToolCalls: 3,
      wallClockTimeoutMs: 10_000,
      llmOutputTimeoutMs: 2_000,
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
      llmOutputTimeoutMs: 2_000,
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

  test("retries after model output timeout and feeds timeout error back to loop when retries are enabled", async () => {
    let turn = 0;
    let executed = 0;

    const result = await runStructuredActionLoop({
      maxToolCalls: 3,
      wallClockTimeoutMs: 10_000,
      llmOutputTimeoutMs: 2_000,
      maxModelTimeouts: 2,
      tools: [makeTool("send_message")],
      callModel: (_messages, _responseFormat, signal) => {
        turn += 1;
        if (turn === 1) {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              const reason: unknown = signal.reason;
              reject(reason instanceof Error ? reason : new Error(String(reason)));
            }, { once: true });
          });
        }
        return Promise.resolve({
          rawText: JSON.stringify({
            status: "done",
            actions: [
              { type: "tool_call", tool_name: "send_message", arguments: { text: "after-timeout", reply: true } },
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
    const hasTimeoutFeedback = result.messages.some((m) =>
      m.role === "user" && m.content.includes("[MODEL TIMEOUT]"),
    );
    expect(hasTimeoutFeedback).toBe(true);
  });

  test("stops on first model output timeout by default", async () => {
    const result = await runStructuredActionLoop({
      maxToolCalls: 3,
      wallClockTimeoutMs: 10_000,
      llmOutputTimeoutMs: 2_000,
      tools: [makeTool("send_message")],
      callModel: (_messages, _responseFormat, signal) => new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const reason: unknown = signal.reason;
          reject(reason instanceof Error ? reason : new Error(String(reason)));
        }, { once: true });
      }),
      initialMessages: [
        { role: "user", content: "hello", timestamp: Date.now() },
      ],
    });

    expect(result.stopReason).toBe("timeout");
    expect(result.timeoutCause).toBe("model_output_timeout");
    expect(result.turns).toBe(1);
    const hasTimeoutFeedback = result.messages.some((m) =>
      m.role === "user" && m.content.includes("[MODEL TIMEOUT]"),
    );
    expect(hasTimeoutFeedback).toBe(false);
  });

  test("reports wall clock timeout cause", async () => {
    const result = await runStructuredActionLoop({
      maxToolCalls: 3,
      wallClockTimeoutMs: 1,
      llmOutputTimeoutMs: 2_000,
      tools: [makeTool("send_message")],
      callModel: () => Promise.resolve({
        rawText: JSON.stringify({
          status: "done",
          actions: [{ type: "ignore_user", reason: "spam" }],
        } satisfies StructuredActionBatch),
      }),
      initialMessages: [
        { role: "user", content: "hello", timestamp: Date.now() },
      ],
      now: (() => {
        let t = 0;
        return () => {
          t += 5;
          return t;
        };
      })(),
    });

    expect(result.stopReason).toBe("timeout");
    expect(result.timeoutCause).toBe("wall_clock_timeout");
  });

  test("emits loop telemetry events for model and tool lifecycle", async () => {
    const events: StructuredLoopEvent[] = [];
    const result = await runStructuredActionLoop({
      maxToolCalls: 3,
      wallClockTimeoutMs: 10_000,
      llmOutputTimeoutMs: 2_000,
      tools: [makeTool("send_message")],
      callModel: () => Promise.resolve({
        rawText: JSON.stringify({
          status: "done",
          actions: [
            { type: "tool_call", tool_name: "send_message", arguments: { text: "hello", reply: true } },
            { type: "stop_response", reason: "done" },
          ],
        } satisfies StructuredActionBatch),
      }),
      onToolCall: () => Promise.resolve({
        content: [{ type: "text", text: "sent" }],
        details: {},
      }),
      initialMessages: [
        { role: "user", content: "hello", timestamp: Date.now() },
      ],
      onLoopEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.stopReason).toBe("done");
    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).toContain("loop_start");
    expect(eventTypes).toContain("turn_start");
    expect(eventTypes).toContain("model_call_start");
    expect(eventTypes).toContain("model_call_end");
    expect(eventTypes).toContain("batch_parsed");
    expect(eventTypes).toContain("tool_call_start");
    expect(eventTypes).toContain("tool_call_end");
    expect(eventTypes).toContain("stop");
  });
});
