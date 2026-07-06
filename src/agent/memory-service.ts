import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "../db/database";
import {
  countMemories,
  createMemory,
  deleteMemory,
  getMemory,
  isMemoryKind,
  listMemories,
  MEMORY_KINDS,
  updateMemory,
  type MemoryKind,
  type MemoryRow,
  type MemoryScope,
} from "../db/memory-repository";
import { completeLlmChat } from "../llm/chat";
import type { OpenRouterChatRequest } from "../llm/types";
import type { LlmProvider, PromptCachingConfig } from "../config/types";
import { prependStableSectionsToPayload, type StablePromptSection } from "./prompt-cache";
import { currentLocalContext } from "../time/agent-time";

export interface MemoryContextInput {
  db: Database;
  guildId: string;
  currentUserId: string;
  resolveUserId?: (userId: string) => string | undefined;
  limit?: number;
  contextInstruction?: string;
}

export interface VisibleUserMemoryContextInput {
  db: Database;
  guildId: string;
  currentUserId: string;
  /** User IDs visible in rendered chat history, newest visible activity first. */
  visibleUserIds: readonly string[];
  resolveUserId?: (userId: string) => string | undefined;
  maxUsers?: number;
  maxMemoriesPerUser?: number;
  maxRows?: number;
  contextInstruction?: string;
}

export interface MemoryExtractionInput {
  db: Database;
  guildId: string;
  currentUserId: string;
  currentUsername: string;
  sourceMessageId: string;
  userMessage: string;
  assistantReply: string;
  recentContext: string;
  timezone?: string;
  provider?: LlmProvider;
  apiKey: string;
  model: string;
  providerParams?: Record<string, unknown>;
  promptCaching: PromptCachingConfig;
  signal?: AbortSignal;
  onPayload?: (payload: unknown) => void;
  onCompletion?: (message: Record<string, unknown>) => void;
  completeChat?: (request: OpenRouterChatRequest) => Promise<{ text: string; messageForLogs: Record<string, unknown> }>;
}

export interface RecordMemoryToolDeps {
  db: Database;
  guildId: string;
  currentUserId: string;
  currentUsername?: string;
  sourceMessageId: string;
  /** Externalized record_memory tool description. */
  recordMemoryDescription?: string;
  /** Resolve a Discord username, with or without @, to a guild-scoped user ID. */
  resolveUsername?: (username: string) => Promise<string | undefined>;
}

type RecordMemoryToolResult = AgentToolResult<{ applied: number; requested: number } | { error: true }>;

interface MemoryMutationInput {
  db: Database;
  guildId: string;
  currentUserId: string;
  currentUsername?: string;
  sourceMessageId: string;
  resolveUsername?: (username: string) => Promise<string | undefined>;
}

type MemorySubject = "global" | "user" | "self";
type ExpiresInUnit = "minutes" | "hours" | "days" | "weeks" | "months";
const MAX_SCRATCHPAD_TTL_MS = 24 * 60 * 60 * 1000;

interface ExpiresIn {
  amount: number;
  unit: ExpiresInUnit;
}

const ExpiresInSchema = Type.Object({
  amount: Type.Number({
    exclusiveMinimum: 0,
    description: "Positive relative duration amount.",
  }),
  unit: Type.Union([
    Type.Literal("minutes"),
    Type.Literal("hours"),
    Type.Literal("days"),
    Type.Literal("weeks"),
    Type.Literal("months"),
  ]),
}, { additionalProperties: false });

const MemoryActionSchema = Type.Union([
  Type.Object({
    action: Type.Literal("none"),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("upsert"),
    id: Type.Optional(Type.Integer({ minimum: 1 })),
    subject: Type.Union([Type.Literal("global"), Type.Literal("user"), Type.Literal("self")], {
      description: "Memory subject scope.",
    }),
    username: Type.Optional(Type.String({
      minLength: 1,
      description: "Username for subject=user.",
    })),
    kind: Type.String({ enum: [...MEMORY_KINDS] }),
    content: Type.String({ minLength: 1 }),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    important: Type.Optional(Type.Boolean()),
    expiresIn: Type.Optional(Type.Union([ExpiresInSchema, Type.Null()], {
      description: "Relative duration for clearly temporary memories; null clears an existing expiry.",
    })),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("delete"),
    id: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
]);

const MemoryExtractionSchema = Type.Object({
  actions: Type.Array(MemoryActionSchema, { maxItems: 5 }),
}, { additionalProperties: false });

type MemoryExtraction = {
  actions: Array<
    | { action: "none" }
    | {
      action: "upsert";
      id?: number;
      subject: MemorySubject;
      username?: string;
      kind: MemoryKind;
      content: string;
      confidence?: number;
      important?: boolean;
      expiresIn?: ExpiresIn | null;
    }
    | { action: "delete"; id: number }
  >;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scopeLabel(row: MemoryRow, currentGuildId: string, resolveUserId?: (userId: string) => string | undefined): string {
  if (row.scope === "self") return "self";
  if (row.subjectUserId === null) {
    return row.guildId !== null && row.guildId !== currentGuildId ? `guild:${row.guildId}` : "guild";
  }
  const username = resolveUserId?.(row.subjectUserId);
  return username !== undefined && username !== "" ? `@${username}` : `user:${row.subjectUserId}`;
}

function formatConfidence(confidence: number): string {
  return confidence.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatExpiry(expiresAt: number, now = Date.now()): string {
  const remainingMs = expiresAt - now;
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (remainingMs <= minuteMs) return "expires in <1 minute";

  const units = remainingMs >= dayMs
    ? { value: Math.ceil(remainingMs / dayMs), label: "day" }
    : remainingMs >= hourMs
      ? { value: Math.ceil(remainingMs / hourMs), label: "hour" }
      : { value: Math.ceil(remainingMs / minuteMs), label: "minute" };
  return `expires in ${units.value} ${units.label}${units.value === 1 ? "" : "s"}`;
}

function memoryClockContext(timezone: string | undefined, now = Date.now()): string {
  const tz = timezone ?? "UTC";
  return currentLocalContext(tz, now);
}

/** Shared policy for memory-writing prompts and the record_memory tool. */
export function buildMemoryPolicyInstructions(): string[] {
  return [
    "Preserve only durable, future-useful memory, prefer updating existing rows over duplicates, and use the narrowest correct scope.",
    "Set important true only for durable memories that must reliably shape behavior across weeks/months.",
  ];
}

/** Build the uncached memory block injected into the conversation prompt. */
export function buildMemoryContext(input: MemoryContextInput): string {
  const limit = Math.max(1, input.limit ?? 80);
  const maxSelfLimit = Math.min(limit, 30);
  const selfTotal = countMemories(input.db, {
    guildId: input.guildId,
    scope: "self",
  });
  const selfRows = listMemories(input.db, {
    guildId: input.guildId,
    scope: "self",
    limit: maxSelfLimit,
  }).filter((row) => row.content.trim() !== "");
  const conversationalLimit = Math.max(0, limit - selfRows.length);
  const conversationalTotal = countMemories(input.db, {
    guildId: input.guildId,
    subjectUserId: input.currentUserId,
    includeGlobal: true,
  });
  const conversationalRows = conversationalLimit > 0
    ? listMemories(input.db, {
        guildId: input.guildId,
        subjectUserId: input.currentUserId,
        includeGlobal: true,
        limit: conversationalLimit,
      }).filter((row) => row.content.trim() !== "")
    : [];
  const total = conversationalTotal + selfTotal;
  const rows = [...conversationalRows, ...selfRows]
    .sort((a, b) => {
      const priorityDiff = a.priority - b.priority;
      if (priorityDiff !== 0) return priorityDiff;
      const updatedDiff = a.updatedAt - b.updatedAt;
      return updatedDiff !== 0 ? updatedDiff : a.id - b.id;
    });

  if (rows.length === 0) return "";

  const lines = rows.map((row) => {
    const label = scopeLabel(row, input.guildId, input.resolveUserId);
    const expiry = row.expiresAt !== null ? ` [${formatExpiry(row.expiresAt)}]` : "";
    return `- ${row.id} [${label}] [${formatConfidence(row.confidence)}] [${row.kind}]${row.priority > 0 ? " [IMPORTANT]" : ""}${expiry} ${row.content}`;
  });
  const showingLine = selfTotal > 0
    ? `Showing ${rows.length}/${total} memories (${conversationalRows.length}/${conversationalTotal} guild/user, ${selfRows.length}/${selfTotal} self).`
    : `Showing ${rows.length}/${total} memories.`;
  const contextInstruction = input.contextInstruction?.trim() !== ""
    ? input.contextInstruction ?? "Use memory as background context."
    : "Use memory as background context.";
  return [
    showingLine,
    contextInstruction,
    ...lines,
  ].join("\n");
}

/** Build memory-pass-only dedupe context for other users visible in chat history. */
export function buildVisibleUserMemoryContext(input: VisibleUserMemoryContextInput): string {
  const maxUsers = input.maxUsers ?? 10;
  const maxMemoriesPerUser = input.maxMemoriesPerUser ?? 10;
  const maxRows = input.maxRows ?? 100;
  const seen = new Set<string>([input.currentUserId]);
  const groups: Array<{ userId: string; rows: MemoryRow[] }> = [];
  let rowCount = 0;

  for (const userId of input.visibleUserIds) {
    if (groups.length >= maxUsers || rowCount >= maxRows) break;
    if (seen.has(userId)) continue;
    seen.add(userId);

    const remainingRows = maxRows - rowCount;
    const rows = listMemories(input.db, {
      guildId: input.guildId,
      subjectUserId: userId,
      limit: Math.min(maxMemoriesPerUser, remainingRows),
    });
    if (rows.length === 0) continue;

    groups.push({ userId, rows });
    rowCount += rows.length;
  }

  if (groups.length === 0) return "";

  const contextInstruction = input.contextInstruction?.trim() !== ""
    ? input.contextInstruction ?? "Use these memories for dedupe only."
    : "Use these memories for dedupe only.";
  const lines = [
    "## Existing Memories For Other Visible Users",
    contextInstruction,
  ];
  for (const group of [...groups].reverse()) {
    const username = input.resolveUserId?.(group.userId);
    const label = username !== undefined && username !== "" ? `@${username}` : `user:${group.userId}`;
    lines.push(`### ${label}`);
    for (const row of [...group.rows].reverse()) {
      const expiry = row.expiresAt !== null ? ` [${formatExpiry(row.expiresAt)}]` : "";
      lines.push(`- ${row.id} [${formatConfidence(row.confidence)}] [${row.kind}]${row.priority > 0 ? " [IMPORTANT]" : ""}${expiry} ${row.content}`);
    }
  }
  return lines.join("\n");
}

function normalizeUsername(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const username = value.trim().replace(/^@+/, "").trim();
  return username !== "" ? username : undefined;
}

function normalizeSubject(value: unknown): MemorySubject {
  if (value === "global" || value === "server") return "global";
  if (value === "self" || value === "own" || value === "bot" || value === "persona") return "self";
  if (value === "user" || value === "other_user" || value === "username") return "user";
  if (typeof value === "string" && value.trim().startsWith("@")) return "user";
  return "user";
}

function normalizeKind(value: unknown): MemoryKind | null {
  return isMemoryKind(value) ? value : null;
}

function normalizeExpiresIn(value: unknown): ExpiresIn | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isRecord(value)) return undefined;

  const { amount, unit } = value;
  if (
    typeof amount !== "number"
    || !Number.isFinite(amount)
    || amount <= 0
    || (unit !== "minutes" && unit !== "hours" && unit !== "days" && unit !== "weeks" && unit !== "months")
  ) {
    return undefined;
  }
  return { amount, unit };
}

function expiresInToMilliseconds(expiresIn: ExpiresIn): number {
  const minuteMs = 60 * 1000;
  const unitMs: Record<ExpiresInUnit, number> = {
    minutes: minuteMs,
    hours: 60 * minuteMs,
    days: 24 * 60 * minuteMs,
    weeks: 7 * 24 * 60 * minuteMs,
    months: 30 * 24 * 60 * minuteMs,
  };
  return expiresIn.amount * unitMs[expiresIn.unit];
}

function expiresInToExpiresAt(expiresIn: ExpiresIn, now = Date.now()): number {
  return Math.round(now + expiresInToMilliseconds(expiresIn));
}

function scratchpadExpiryIsValid(
  action: Extract<MemoryExtraction["actions"][number], { action: "upsert" }>,
  existing: MemoryRow | null,
): boolean {
  if (action.kind !== "scratchpad") return true;
  if (action.expiresIn === null) return false;
  if (action.expiresIn !== undefined) return expiresInToMilliseconds(action.expiresIn) <= MAX_SCRATCHPAD_TTL_MS;
  return existing?.kind === "scratchpad" && existing.expiresAt !== null;
}

function memoryKindScopeIsValid(kind: MemoryKind, scope: MemoryScope): boolean {
  return kind !== "journal" || scope === "self";
}

function normalizeExtractionAction(value: unknown): MemoryExtraction["actions"][number] | null {
  if (!isRecord(value)) return null;
  const rawAction = value.action;
  if (rawAction === "none") return { action: "none" };

  if (rawAction === "delete") {
    const id = value.id;
    return typeof id === "number" && Number.isInteger(id) && id > 0 ? { action: "delete", id } : null;
  }

  if (rawAction === "upsert" || rawAction === "add" || rawAction === "create" || rawAction === "update") {
    const content = typeof value.content === "string" ? value.content.trim() : "";
    if (content === "") return null;
    const id = typeof value.id === "number" && Number.isInteger(value.id) && value.id > 0 ? value.id : undefined;
    const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
      ? Math.max(0, Math.min(1, value.confidence))
      : undefined;
    if ("expiresAt" in value) return null;
    const expiresIn = normalizeExpiresIn(value.expiresIn);
    if ("expiresIn" in value && expiresIn === undefined) return null;
    const kind = "kind" in value ? normalizeKind(value.kind) : "fact";
    if (kind === null) return null;
    return {
      action: "upsert",
      ...(id !== undefined ? { id } : {}),
      subject: normalizeSubject(value.subject),
      ...(normalizeUsername(value.username ?? value.subject) !== undefined
        ? { username: normalizeUsername(value.username ?? value.subject) }
        : {}),
      kind,
      content,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(typeof value.important === "boolean" ? { important: value.important } : {}),
      ...(expiresIn !== undefined ? { expiresIn } : {}),
    };
  }

  return null;
}

function normalizeExtractionShape(parsed: unknown): unknown {
  const rawActions = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.actions)
      ? parsed.actions
      : null;
  if (rawActions === null) return parsed;

  const actions = rawActions
    .slice(0, 5)
    .map(normalizeExtractionAction)
    .filter((action): action is NonNullable<typeof action> => action !== null);
  return { actions: actions.length > 0 ? actions : [{ action: "none" }] };
}

function parseExtraction(rawText: string): MemoryExtraction | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
  parsed = normalizeExtractionShape(parsed);
  if (!Value.Check(MemoryExtractionSchema, parsed)) return null;
  return parsed as MemoryExtraction;
}

function memoryExtractionResponseFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "memory_extraction",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["actions"],
        properties: {
          actions: {
            type: "array",
            maxItems: 5,
            items: {
              anyOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["action"],
                  properties: { action: { const: "none" } },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["action", "subject", "kind", "content"],
                  properties: {
                    action: { const: "upsert" },
                    id: { type: "integer", minimum: 1 },
                    subject: { type: "string", enum: ["global", "user", "self"] },
                    username: { type: "string", minLength: 1 },
                    kind: { type: "string", enum: [...MEMORY_KINDS] },
                    content: { type: "string", minLength: 1 },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    important: { type: "boolean" },
                    expiresIn: {
                      anyOf: [
                        {
                          type: "object",
                          additionalProperties: false,
                          required: ["amount", "unit"],
                          properties: {
                            amount: { type: "number", exclusiveMinimum: 0 },
                            unit: { type: "string", enum: ["minutes", "hours", "days", "weeks", "months"] },
                          },
                        },
                        { type: "null" },
                      ],
                    },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["action", "id"],
                  properties: {
                    action: { const: "delete" },
                    id: { type: "integer", minimum: 1 },
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
}

function buildExtractionPrompt(input: MemoryExtractionInput): string {
  const current = buildMemoryContext({
    db: input.db,
    guildId: input.guildId,
    currentUserId: input.currentUserId,
  });
  return [
    "Extract only durable memory updates or short-lived scratchpad updates from this Discord exchange.",
    ...buildMemoryPolicyInstructions(),
    "If Existing memories is (none), deletion is impossible; return none or upsert only.",
    "",
    "Existing memories:",
    current !== "" ? current : "(none)",
    "",
    "Current time for expiresIn decisions:",
    memoryClockContext(input.timezone),
    "",
    ...(input.recentContext.trim() !== ""
      ? [
          "Recent chat context:",
          input.recentContext.trim(),
          "",
        ]
      : []),
    `Current speaker: @${input.currentUsername} (${input.currentUserId})`,
    `User message: ${input.userMessage}`,
    `Bot reply: ${input.assistantReply}`,
  ].join("\n");
}

function editableMemory(input: MemoryMutationInput, id: number): MemoryRow | null {
  const existing = getMemory(input.db, id);
  if (existing === null) return null;
  if (existing.guildId !== null && existing.guildId !== input.guildId) return null;
  return existing;
}

function duplicateMemory(
  input: MemoryMutationInput,
  scope: MemoryScope,
  subjectUserId: string | null,
  kind: MemoryKind,
  content: string,
): MemoryRow | null {
  const normalized = content.trim().toLowerCase();
  const rows = listMemories(input.db, {
    guildId: input.guildId,
    scope,
    subjectUserId,
  });
  return rows.find((row) =>
    row.scope === scope
    && row.subjectUserId === subjectUserId
    && row.kind === kind
    && row.content.trim().toLowerCase() === normalized
  ) ?? null;
}

interface MemoryActionTarget {
  scope: MemoryScope;
  subjectUserId: string | null;
}

async function actionMemoryTarget(
  input: MemoryMutationInput,
  action: Extract<MemoryExtraction["actions"][number], { action: "upsert" }>,
  existing: MemoryRow | null,
): Promise<MemoryActionTarget | undefined> {
  if (existing !== null) return { scope: existing.scope, subjectUserId: existing.subjectUserId };
  if (action.subject === "self") return { scope: "self", subjectUserId: null };
  if (action.subject === "global") return { scope: "guild", subjectUserId: null };

  const username = normalizeUsername(action.username);
  if (username === undefined) return undefined;
  if (input.currentUsername !== undefined && username.toLowerCase() === input.currentUsername.toLowerCase()) {
    return { scope: "user", subjectUserId: input.currentUserId };
  }
  if (input.resolveUsername === undefined) return undefined;
  const subjectUserId = await input.resolveUsername(username);
  return subjectUserId !== undefined ? { scope: "user", subjectUserId } : undefined;
}

async function applyMemoryActions(input: MemoryMutationInput, extraction: MemoryExtraction): Promise<number> {
  let applied = 0;
  for (const action of extraction.actions) {
    if (action.action === "none") continue;
    if (action.action === "delete") {
      if (editableMemory(input, action.id) === null) continue;
      deleteMemory(input.db, action.id);
      applied += 1;
      continue;
    }

    const existing = action.id !== undefined ? editableMemory(input, action.id) : null;
    if (action.id !== undefined && existing === null) continue;

    const target = await actionMemoryTarget(input, action, existing);
    if (target === undefined) continue;
    if (!memoryKindScopeIsValid(action.kind, target.scope)) continue;
    if (!scratchpadExpiryIsValid(action, existing)) continue;
    const expiresAt = action.expiresIn === undefined
      ? undefined
      : action.expiresIn === null
        ? null
        : expiresInToExpiresAt(action.expiresIn);
    const payload = {
      scope: target.scope,
      ...(target.scope === "guild" ? { guildId: input.guildId } : {}),
      subjectUserId: target.subjectUserId,
      kind: action.kind,
      content: action.content.trim(),
      sourceMessageId: input.sourceMessageId,
      provenance: {
        sourceMessageIds: [input.sourceMessageId],
        guildId: input.guildId,
        userId: input.currentUserId,
        capturedAt: Date.now(),
      },
      confidence: action.confidence,
      ...(action.important !== undefined ? { priority: action.important ? 1 : 0 } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    if (payload.content === "") continue;

    if (action.id !== undefined) {
      updateMemory(input.db, action.id, payload);
      applied += 1;
      continue;
    }

    const duplicate = duplicateMemory(input, target.scope, target.subjectUserId, action.kind, payload.content);
    if (duplicate !== null) {
      if (action.important === true && duplicate.priority < 1) {
        updateMemory(input.db, duplicate.id, { priority: 1 });
        applied += 1;
      }
      continue;
    }

    createMemory(input.db, {
      guildId: input.guildId,
      ...payload,
    });
    applied += 1;
  }
  return applied;
}

/** Create the state-changing tool used by the silent post-reply memory pass. */
export function createRecordMemoryTool(deps: RecordMemoryToolDeps): AgentTool {
  const description = deps.recordMemoryDescription?.trim();
  return {
    name: "record_memory",
    label: "record_memory",
    description: description !== undefined && description !== ""
      ? description
      : "Record memory updates after a Discord turn.",
    parameters: MemoryExtractionSchema,

    async execute(_toolCallId: string, params: unknown): Promise<RecordMemoryToolResult> {
      const normalized = normalizeExtractionShape(params);
      if (!Value.Check(MemoryExtractionSchema, normalized)) {
        return {
          content: [{ type: "text", text: "Memory update rejected: arguments did not match the schema." }],
          details: { error: true },
        };
      }

      const extraction = normalized as MemoryExtraction;
      const applied = await applyMemoryActions(deps, extraction);
      return {
        content: [{ type: "text", text: `Memory update complete; applied ${applied} of ${extraction.actions.length} requested action(s).` }],
        details: { applied, requested: extraction.actions.length },
      };
    },
  };
}

/** Run background memory extraction and apply accepted updates. */
export async function extractAndApplyMemories(input: MemoryExtractionInput): Promise<void> {
  const complete = input.completeChat ?? completeLlmChat;
  const stable: StablePromptSection[] = [{
    role: "system",
    text: "You are a memory extraction task; return only JSON matching the schema.",
  }];
  const result = await complete({
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model,
    systemPrompt: input.provider === "openai-codex" ? stable.map((section) => section.text).join("\n\n") : "",
    messages: [{ role: "user", content: buildExtractionPrompt(input) }],
    providerParams: input.providerParams,
    responseFormat: memoryExtractionResponseFormat(),
    signal: input.signal,
    onPayload: (payload) => {
      if (input.provider !== "openai-codex") {
        prependStableSectionsToPayload(payload, stable, input.promptCaching, input.model);
      }
      input.onPayload?.(payload);
    },
  });
  input.onCompletion?.(result.messageForLogs);

  const extracted = parseExtraction(result.text);
  if (extracted === null) return;

  await applyMemoryActions(input, extracted);
}
