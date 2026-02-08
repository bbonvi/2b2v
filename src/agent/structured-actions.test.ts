import { describe, test, expect } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
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
});

describe("buildStructuredActionProtocolPrompt", () => {
  test("reinforces ignore policy for direct mentions and questions", () => {
    const prompt = buildStructuredActionProtocolPrompt([makeTool("send_message"), makeTool("start_typing")]);
    expect(prompt).toContain("For direct mentions or direct questions, default to responding via send_message.");
    expect(prompt).toContain("Only use ignore_user when silence is clearly better");
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
            { type: "tool_call", tool_name: "send_message", arguments: { value: "hello" } },
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
        { type: "tool_call", tool_name: "send_message", arguments: { value: "1" } },
        { type: "tool_call", tool_name: "send_message", arguments: { value: "2" } },
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
});
