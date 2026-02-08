import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { validateToolArguments, type ToolCall } from "@mariozechner/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { resolvePromptPolicy } from "./prompt-policy.ts";

const ToolCallActionSchema = Type.Object({
  type: Type.Literal("tool_call"),
  tool_name: Type.String({ minLength: 1 }),
  arguments: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: false });

const StopResponseActionSchema = Type.Object({
  type: Type.Literal("stop_response"),
  reason: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const IgnoreUserActionSchema = Type.Object({
  type: Type.Literal("ignore_user"),
  reason: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const StructuredActionSchema = Type.Union([
  ToolCallActionSchema,
  StopResponseActionSchema,
  IgnoreUserActionSchema,
]);

const StructuredActionBatchSchema = Type.Object({
  status: Type.Union([Type.Literal("continue"), Type.Literal("done")]),
  actions: Type.Array(StructuredActionSchema, { maxItems: 16 }),
  notes: Type.Optional(Type.String()),
}, { additionalProperties: false });

export type ToolCallAction = Static<typeof ToolCallActionSchema>;
export type StopResponseAction = Static<typeof StopResponseActionSchema>;
export type IgnoreUserAction = Static<typeof IgnoreUserActionSchema>;
export type StructuredAction = Static<typeof StructuredActionSchema>;
export type StructuredActionBatch = Static<typeof StructuredActionBatchSchema>;

export interface LoopMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export type LoopStopReason =
  | "done"
  | "ignored"
  | "timeout"
  | "max_tool_calls"
  | "max_turns"
  | "invalid_format"
  | "aborted";

export interface ModelTurnOutput {
  rawText: string;
  responsePayload?: Record<string, unknown>;
}

export interface RunStructuredActionLoopInput {
  initialMessages: LoopMessage[];
  tools: AgentTool[];
  maxToolCalls: number;
  wallClockTimeoutMs: number;
  callModel: (
    messages: LoopMessage[],
    responseFormat: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ModelTurnOutput>;
  onToolCall?: (
    tool: AgentTool,
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<AgentToolResult<unknown>>;
  now?: () => number;
  signal?: AbortSignal;
  maxTurns?: number;
  maxFormatErrors?: number;
  onModelTurn?: (payload: Record<string, unknown> | undefined) => void;
}

export interface RunStructuredActionLoopResult {
  stopReason: LoopStopReason;
  toolCalls: number;
  turns: number;
  messages: LoopMessage[];
}

const SEND_MESSAGE_TOOL_NAME = "send_message";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function flattenErrors(value: unknown): string {
  const errors = [...Value.Errors(StructuredActionBatchSchema, value)];
  if (errors.length === 0) return "Unknown schema validation error";
  return errors
    .slice(0, 3)
    .map((err) => `${err.path === "" ? "/" : err.path}: ${err.message}`)
    .join("; ");
}

function extractJsonCandidate(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
    const lines = trimmed.split("\n");
    if (lines.length >= 2) {
      const body = lines.slice(1, -1).join("\n").trim();
      if (body !== "") return body;
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

export function parseStructuredActionBatch(rawText: string):
  | { ok: true; value: StructuredActionBatch }
  | { ok: false; error: string } {
  const candidate = extractJsonCandidate(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, error: "Output is not valid JSON" };
  }

  if (!Value.Check(StructuredActionBatchSchema, parsed)) {
    return {
      ok: false,
      error: flattenErrors(parsed),
    };
  }

  return { ok: true, value: parsed };
}

function schemaForToolAction(tool: AgentTool): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "tool_name", "arguments"],
    properties: {
      type: { const: "tool_call" },
      tool_name: { const: tool.name },
      arguments: tool.parameters,
    },
  };
}

function schemaForStopAction(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "reason"],
    properties: {
      type: { const: "stop_response" },
      reason: { type: "string", minLength: 1 },
    },
  };
}

function schemaForIgnoreAction(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "reason"],
    properties: {
      type: { const: "ignore_user" },
      reason: { type: "string", minLength: 1 },
    },
  };
}

export function buildActionResponseFormat(tools: AgentTool[]): Record<string, unknown> {
  const actionVariants = [
    ...tools.map((tool) => schemaForToolAction(tool)),
    schemaForStopAction(),
    schemaForIgnoreAction(),
  ];

  return {
    type: "json_schema",
    json_schema: {
      name: "agent_action_batch",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["status", "actions"],
        properties: {
          status: { type: "string", enum: ["continue", "done"] },
          actions: {
            type: "array",
            maxItems: 16,
            items: { anyOf: actionVariants },
          },
          notes: { type: "string" },
        },
      },
    },
  };
}

export function buildStructuredActionProtocolPrompt(tools: AgentTool[]): string {
  const toolList = tools
    .map((tool) => `- ${tool.name}: ${tool.description}`)
    .join("\n");
  const toolNames = new Set(tools.map((tool) => tool.name));
  const promptPolicy = resolvePromptPolicy(toolNames);

  return [
    "## Structured Action Protocol (Highest Priority)",
    "You MUST output a single JSON object matching the schema enforced by response_format.",
    "Never output plain text outside JSON.",
    "Valid actions:",
    '- {"type":"tool_call","tool_name":"<tool>","arguments":{...}}',
    '- {"type":"stop_response","reason":"..."}',
    '- {"type":"ignore_user","reason":"..."}',
    'Use `status: "continue"` when expecting another turn after tool results.',
    'Use `status: "done"` when finished for this interaction.',
    ...promptPolicy.sharedRules.map((rule) => rule.text),
    "Never use ignore_user as a shortcut to avoid replying to a user ping.",
    "If you intentionally decide not to respond to the user, include ignore_user action.",
    "Only send user-visible output via tool_call to send_message.",
    "Do not use stop_response or status=done before at least one send_message action in this interaction.",
    ...(promptPolicy.toolRules.length > 0
      ? [
        "",
        "Tool-specific reinforcement for available tools:",
        ...promptPolicy.toolRules.map((rule) => `- ${rule.text}`),
      ]
      : []),
    ...(promptPolicy.researchWorkflowRules.length > 0
      ? [
        "",
        ...promptPolicy.researchWorkflowRules.map((rule, idx) => idx === 0 ? rule.text : `- ${rule.text}`),
      ]
      : []),
    "",
    "Available tools:",
    toolList,
  ].join("\n");
}

function summarizeToolResult(result: AgentToolResult<unknown>): string {
  const textContent = result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (textContent !== "") {
    return textContent;
  }

  const details = result.details;
  if (details === undefined) return "(no tool output)";
  try {
    return JSON.stringify(details);
  } catch {
    return "(unserializable tool details)";
  }
}

function makeUserMessage(content: string, now: () => number): LoopMessage {
  return { role: "user", content, timestamp: now() };
}

function makeAssistantMessage(content: string, now: () => number): LoopMessage {
  return { role: "assistant", content, timestamp: now() };
}

function buildFormatErrorFeedback(error: string): string {
  return [
    "[FORMAT ERROR]",
    "Output must be strict JSON matching schema:",
    '{"status":"continue|done","actions":[...],"notes":"optional"}',
    "Never output plain text outside JSON.",
    `Validation error: ${error}`,
  ].join("\n");
}

function buildToolResultFeedback(toolName: string, resultText: string): string {
  return [
    `[TOOL RESULT] ${toolName}`,
    resultText,
  ].join("\n");
}

function buildToolErrorFeedback(toolName: string, error: string): string {
  return [
    `[TOOL ERROR] ${toolName}`,
    error,
  ].join("\n");
}

function buildPolicyErrorFeedback(error: string): string {
  return [
    "[POLICY ERROR]",
    error,
    "If you intentionally choose silence, use ignore_user.",
    "If you are responding, call send_message first, then finish with stop_response or status done.",
  ].join("\n");
}

function isValidIgnoreUserReason(reason: string): boolean {
  const normalized = reason.trim().toLowerCase();
  if (normalized === "") return false;

  const isSpamLike = /\b(spam|flood|abuse|harass|troll)\b/.test(normalized);
  const isNonActionable = /\b(non[- ]?actionable|no actionable request|no response needed|no useful response|low[- ]value|no-value)\b/.test(normalized);
  const hasIgnoreIntent = /\b(ignore|ignored|silence)\b/.test(normalized);
  const hasExplicitMarker = /\b(explicit|explicitly|asked|request(?:ed)?|user asked)\b/.test(normalized);
  const isExplicitIgnore = (hasIgnoreIntent && hasExplicitMarker) || /\b(ignore me|ignore this)\b/.test(normalized);

  return isSpamLike || isNonActionable || isExplicitIgnore;
}

function buildToolCallId(turn: number, index: number): string {
  return `loop-${turn}-tool-${index}`;
}

export async function runStructuredActionLoop(input: RunStructuredActionLoopInput): Promise<RunStructuredActionLoopResult> {
  const now = input.now ?? (() => Date.now());
  const maxTurns = input.maxTurns ?? 24;
  const maxFormatErrors = input.maxFormatErrors ?? 3;
  const startedAt = now();
  const responseFormat = buildActionResponseFormat(input.tools);

  const toolsByName = new Map<string, AgentTool>();
  for (const tool of input.tools) {
    toolsByName.set(tool.name, tool);
  }

  const messages: LoopMessage[] = [...input.initialMessages];

  let turns = 0;
  let toolCalls = 0;
  let formatErrors = 0;
  let hasUserVisibleMessage = false;

  const executeToolCall = input.onToolCall ?? (async (tool, toolCallId, args, signal) => {
    const toolCall: ToolCall = {
      type: "toolCall",
      id: toolCallId,
      name: tool.name,
      arguments: args,
    };
    validateToolArguments(tool, toolCall);
    return await tool.execute(toolCallId, args, signal);
  });

  while (turns < maxTurns) {
    if (input.signal?.aborted === true) {
      return { stopReason: "aborted", toolCalls, turns, messages };
    }

    if (now() - startedAt >= input.wallClockTimeoutMs) {
      return { stopReason: "timeout", toolCalls, turns, messages };
    }

    turns += 1;

    const turnOutput = await input.callModel(messages, responseFormat, input.signal);
    input.onModelTurn?.(turnOutput.responsePayload);

    messages.push(makeAssistantMessage(turnOutput.rawText, now));

    const parsed = parseStructuredActionBatch(turnOutput.rawText);
    if (!parsed.ok) {
      formatErrors += 1;
      messages.push(makeUserMessage(buildFormatErrorFeedback(parsed.error), now));
      if (formatErrors >= maxFormatErrors) {
        return { stopReason: "invalid_format", toolCalls, turns, messages };
      }
      continue;
    }

    formatErrors = 0;
    const batch = parsed.value;
    let policyError: string | null = null;

    let actionIndex = 0;
    for (const action of batch.actions) {
      actionIndex += 1;

      if (action.type === "stop_response") {
        if (hasUserVisibleMessage) {
          return { stopReason: "done", toolCalls, turns, messages };
        }
        policyError = "stop_response is invalid before any send_message action.";
        break;
      }

      if (action.type === "ignore_user") {
        if (!isValidIgnoreUserReason(action.reason)) {
          policyError = "ignore_user reason must indicate spam, non-actionable input, or explicit request to ignore.";
          break;
        }
        return { stopReason: "ignored", toolCalls, turns, messages };
      }

      if (toolCalls >= input.maxToolCalls) {
        return { stopReason: "max_tool_calls", toolCalls, turns, messages };
      }

      const tool = toolsByName.get(action.tool_name.trim());
      if (tool === undefined) {
        messages.push(makeUserMessage(buildToolErrorFeedback(action.tool_name, "Unknown tool"), now));
        continue;
      }

      const argsRecord = asRecord(action.arguments);
      if (argsRecord === null) {
        messages.push(makeUserMessage(buildToolErrorFeedback(tool.name, "arguments must be an object"), now));
        continue;
      }

      if (tool.name === SEND_MESSAGE_TOOL_NAME && typeof argsRecord.reply !== "boolean") {
        policyError = "send_message requires explicit reply boolean (true or false).";
        break;
      }

      const toolCallId = buildToolCallId(turns, actionIndex);
      toolCalls += 1;

      try {
        const result = await executeToolCall(tool, toolCallId, argsRecord, input.signal);
        messages.push(makeUserMessage(buildToolResultFeedback(tool.name, summarizeToolResult(result)), now));
        if (tool.name === SEND_MESSAGE_TOOL_NAME) {
          hasUserVisibleMessage = true;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown tool execution error";
        messages.push(makeUserMessage(buildToolErrorFeedback(tool.name, msg), now));
      }
    }

    if (policyError !== null) {
      messages.push(makeUserMessage(buildPolicyErrorFeedback(policyError), now));
      continue;
    }

    if (batch.status === "done") {
      if (!hasUserVisibleMessage) {
        messages.push(makeUserMessage(
          buildPolicyErrorFeedback("status=done is invalid before any send_message action."),
          now,
        ));
        continue;
      }
      return { stopReason: "done", toolCalls, turns, messages };
    }
  }

  return { stopReason: "max_turns", toolCalls, turns, messages };
}
