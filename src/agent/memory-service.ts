import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Database } from "../db/database";
import {
  createMemory,
  deleteMemory,
  getMemory,
  listMemories,
  updateMemory,
  type MemoryKind,
  type MemoryRow,
} from "../db/memory-repository";
import { completeLlmChat, type OpenRouterChatRequest } from "../llm/openrouter-chat";
import type { LlmProvider, PromptCachingConfig } from "../config/types";
import { prependStableSectionsToPayload, type StablePromptSection } from "./prompt-cache";
import { currentLocalContext } from "../time/agent-time";

export interface MemoryContextInput {
  db: Database;
  guildId: string;
  currentUserId: string;
  resolveUserId?: (userId: string) => string | undefined;
  limit?: number;
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
  sourceMessageId: string;
  /** Resolve a Discord username, with or without @, to a guild-scoped user ID. */
  resolveUsername?: (username: string) => Promise<string | undefined>;
}

type RecordMemoryToolResult = AgentToolResult<{ applied: number; requested: number } | { error: true }>;

interface MemoryMutationInput {
  db: Database;
  guildId: string;
  currentUserId: string;
  sourceMessageId: string;
  resolveUsername?: (username: string) => Promise<string | undefined>;
}

type MemorySubject = "global" | "current_user" | "user";

const MemoryActionSchema = Type.Union([
  Type.Object({
    action: Type.Literal("none"),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("upsert"),
    id: Type.Optional(Type.Integer({ minimum: 1 })),
    subject: Type.Union([Type.Literal("global"), Type.Literal("current_user"), Type.Literal("user")], {
      description: "global for shared context, current_user for the triggering user, user for another Discord user.",
    }),
    username: Type.Optional(Type.String({
      minLength: 1,
      description: "Required when subject=user. Leading @ is optional.",
    })),
    kind: Type.Union([
      Type.Literal("global_note"),
      Type.Literal("user_note"),
      Type.Literal("preference"),
      Type.Literal("relationship"),
      Type.Literal("project"),
      Type.Literal("fact"),
    ]),
    content: Type.String({ minLength: 1 }),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    expiresAt: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()], {
      description: "Unix epoch milliseconds when this clearly temporary memory should expire; null clears an existing expiry.",
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
      expiresAt?: number | null;
    }
    | { action: "delete"; id: number }
  >;
};

const MEMORY_KINDS = ["global_note", "user_note", "preference", "relationship", "project", "fact"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scopeLabel(row: MemoryRow, resolveUserId?: (userId: string) => string | undefined): string {
  if (row.subjectUserId === null) return "global";
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
  return [
    currentLocalContext(tz, now),
    `Current Unix epoch milliseconds: ${now}`,
  ].join("\n");
}

/** Build the uncached memory block injected into the conversation prompt. */
export function buildMemoryContext(input: MemoryContextInput): string {
  const rows = listMemories(input.db, {
    guildId: input.guildId,
    subjectUserId: input.currentUserId,
    includeGlobal: true,
    limit: input.limit ?? 40,
  }).filter((row) => row.content.trim() !== "");

  if (rows.length === 0) return "";

  const lines = rows.map((row) => {
    const label = scopeLabel(row, input.resolveUserId);
    const expiry = row.expiresAt !== null ? ` [${formatExpiry(row.expiresAt)}]` : "";
    return `- ${row.id} [${label}] [${formatConfidence(row.confidence)}] [${row.kind}]${expiry} ${row.content}`;
  });
  return [
    "Use these durable memories as background context. Current chat instructions override memory. The number after scope is confidence (0-1); weigh lower confidence accordingly.",
    ...lines,
  ].join("\n");
}

function normalizeUsername(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const username = value.trim().replace(/^@+/, "").trim();
  return username !== "" ? username : undefined;
}

function normalizeSubject(value: unknown): MemorySubject {
  if (value === "global" || value === "server") return "global";
  if (value === "user" || value === "other_user" || value === "username") return "user";
  if (typeof value === "string" && value.trim().startsWith("@")) return "user";
  return "current_user";
}

function normalizeKind(value: unknown): MemoryKind {
  return typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value)
    ? value as MemoryKind
    : "fact";
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
    const expiresAt = typeof value.expiresAt === "number" && Number.isInteger(value.expiresAt) && value.expiresAt >= 0
      ? value.expiresAt
      : value.expiresAt === null
        ? null
        : undefined;
    return {
      action: "upsert",
      ...(id !== undefined ? { id } : {}),
      subject: normalizeSubject(value.subject),
      ...(normalizeUsername(value.username ?? value.subject) !== undefined
        ? { username: normalizeUsername(value.username ?? value.subject) }
        : {}),
      kind: normalizeKind(value.kind),
      content,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
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
                    subject: { type: "string", enum: ["global", "current_user", "user"] },
                    username: { type: "string", minLength: 1 },
                    kind: { type: "string", enum: ["global_note", "user_note", "preference", "relationship", "project", "fact"] },
                    content: { type: "string", minLength: 1 },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    expiresAt: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
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
    "Extract only durable memory updates from this Discord exchange.",
    "Preserve a memory only if it is likely to be useful in a future conversation or future bot decision.",
    "If the fact cannot change how the bot should reply or act later, return action=none.",
    "Save stable user preferences, preferred or real names, explicit name/pronoun/language corrections, long-term facts, recurring project context, relationships, and explicit corrections.",
    "Record explicit and strongly implied durable facts, preferences, relationships, routines, constraints, identity details, projects, and recurring behaviors when they could matter later; the user does not need to ask you to remember.",
    "The triggering user is only the source of this memory pass, not the only valid memory subject. Inspect the current exchange and recent chat context for durable, future-useful memories about any clearly identifiable user or shared context; use subject=user with username for another user when appropriate.",
    "Be proactive but selective: record context-derived or implied memories only when they are likely to affect future replies, reveal a stable pattern, or clarify relationships, preferences, constraints, projects, or routines.",
    "For subtle, uncertain, or pattern-based memories, use lower confidence and tentative standalone phrasing; if the clue is likely to become stale, use a conservative expiresAt. Keep the memory content short and avoid verbose meta-commentary.",
    "Use lower confidence for indirect, inferred, or pattern-based memories.",
    "Write each memory as a standalone factual note that remains clear without hidden chat context, prior assumptions, or what the bot previously believed.",
    "Do not save jokes, transient moods, ordinary chat, pleasantries, reactions, filler, or one-off requests.",
    "When in doubt, do not save it.",
    "Do not record preferences that only apply to the current request unless the user asks to remember them, the wording clearly describes a general future preference, or the surrounding pattern strongly implies a recurring durable preference or rapport detail.",
    "Before creating a new memory, check whether an existing memory should be updated, compressed, or deleted instead.",
    "Do not store the same underlying memory in multiple scopes. If a new memory overlaps an existing one, update that existing id with a shorter merged version instead of creating another row.",
    "Prefer updating an existing memory id over creating duplicates. Actively delete stale or superseded existing memories when the current exchange clearly replaces them.",
    "Keep memories compact. Normal memory should be one sentence; dense memories may replace several near-duplicate rows, but should still stay short, around <=350 chars unless the user explicitly asked to preserve detailed instructions.",
    "Only delete a memory when an existing memory is listed below and the new chat clearly makes that specific memory obsolete, false, or superseded.",
    "If Existing memories is (none), deletion is impossible; return none or upsert only. Never invent memory ids.",
    "Prefer the narrowest correct scope: subject=current_user for triggering-user preferences/facts, subject=user with username for another named user, and subject=global only for shared server/project facts or explicit bot-wide rules.",
    "Do not turn one user's preference into a global memory unless explicitly asked to apply it globally or to everyone.",
    "Set expiresAt only for clearly temporary memories, such as current-event context, short-lived projects, temporary availability, deadlines, or explicitly time-limited preferences. Use future Unix epoch milliseconds based on the current time below.",
    "Never set expiresAt to a past time or to seconds; if you cannot determine a future millisecond expiry, leave expiresAt unset.",
    "Do not overuse expiresAt. Do not set expiry for names, pronouns, stable preferences, relationships, durable facts, or things likely to live a long time; permanent is fine because stale memories can be removed later.",
    "When a temporary memory is reinforced into a permanent memory, set expiresAt=null on that existing id. When temporary context is extended, update expiresAt to the new later time.",
    "Do not persist facts that come only from system/developer context, persona, tool instructions, or bot implementation details.",
    "Focus on what the human user newly revealed or corrected in the chat exchange.",
    "If the user asks to remember something, treat that as strong intent to preserve the underlying fact/preference if it can matter later.",
    "If the bot reply says it will remember something, do not save the promise itself; save the user's underlying fact/preference when it is future-useful.",
    "Save rapport, teasing, tone, or help preferences only when the user clearly revealed a durable preference or relationship fact.",
    "Do not save trivia just because it is interesting.",
    "You may also record a durable fact from recent chat context if the current exchange makes its importance clear; do not limit yourself to the last message.",
    "If the user says their name, preferred name, or corrects what they should be called, preserve it as current_user unless it is obviously a joke or roleplay.",
    "",
    "Existing memories:",
    current !== "" ? current : "(none)",
    "",
    "Current time for expiresAt calculations:",
    memoryClockContext(input.timezone),
    "",
    ...(input.recentContext.trim() !== ""
      ? [
          "Recent chat context:",
          input.recentContext.trim(),
          "",
        ]
      : []),
    `Current user: @${input.currentUsername} (${input.currentUserId})`,
    `User message: ${input.userMessage}`,
    `Bot reply: ${input.assistantReply}`,
  ].join("\n");
}

function editableMemory(input: MemoryMutationInput, id: number): MemoryRow | null {
  const existing = getMemory(input.db, id);
  if (existing === null) return null;
  if (existing.guildId !== input.guildId) return null;
  return existing;
}

function duplicateMemory(
  input: MemoryMutationInput,
  subjectUserId: string | null,
  kind: MemoryKind,
  content: string,
): MemoryRow | null {
  const normalized = content.trim().toLowerCase();
  const rows = listMemories(input.db, {
    guildId: input.guildId,
  });
  return rows.find((row) =>
    row.subjectUserId === subjectUserId
    && row.kind === kind
    && row.content.trim().toLowerCase() === normalized
  ) ?? null;
}

async function actionSubjectUserId(
  input: MemoryMutationInput,
  action: Extract<MemoryExtraction["actions"][number], { action: "upsert" }>,
  existing: MemoryRow | null,
): Promise<string | null | undefined> {
  if (existing !== null) return existing.subjectUserId;
  if (action.subject === "global") return null;
  if (action.subject === "current_user") return input.currentUserId;

  const username = normalizeUsername(action.username);
  if (username === undefined || input.resolveUsername === undefined) return undefined;
  return await input.resolveUsername(username);
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

    const subjectUserId = await actionSubjectUserId(input, action, existing);
    if (subjectUserId === undefined) continue;
    if (typeof action.expiresAt === "number" && action.expiresAt <= Date.now()) continue;
    const payload = {
      subjectUserId,
      kind: action.kind,
      content: action.content.trim(),
      sourceMessageId: input.sourceMessageId,
      confidence: action.confidence,
      ...(action.expiresAt !== undefined ? { expiresAt: action.expiresAt } : {}),
    };
    if (payload.content === "") continue;

    if (action.id !== undefined) {
      updateMemory(input.db, action.id, payload);
      applied += 1;
      continue;
    }

    if (duplicateMemory(input, subjectUserId, action.kind, payload.content) !== null) {
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
  return {
    name: "record_memory",
    label: "record_memory",
    description: [
      "Record durable memory updates after a Discord turn has already completed.",
      "Use only for stable facts, preferences, names/pronouns/language corrections, relationships, recurring project context, or explicit corrections that can affect future replies or bot decisions.",
      "Record explicit and strongly implied durable facts, preferences, relationships, routines, constraints, identity details, projects, and recurring behaviors when they could matter later; the user does not need to ask you to remember.",
      "The triggering user is only the source of this memory pass, not the only valid memory subject. Inspect the current exchange and recent chat context for durable, future-useful memories about any clearly identifiable user or shared context; use subject=user with username for another user when appropriate.",
      "Be proactive but selective: record context-derived or implied memories only when they are likely to affect future replies, reveal a stable pattern, or clarify relationships, preferences, constraints, projects, or routines.",
      "For subtle, uncertain, or pattern-based memories, use lower confidence and tentative standalone phrasing; if the clue is likely to become stale, use a conservative expiresAt. Keep the memory content short and avoid verbose meta-commentary.",
      "Use lower confidence for indirect, inferred, or pattern-based memories.",
      "Write each memory as a standalone factual note that remains clear without hidden chat context, prior assumptions, or what the bot previously believed.",
      "Do not record jokes, transient moods, filler, ordinary one-off requests, or facts that cannot plausibly matter later.",
      "Do not record preferences that only apply to the current request unless the user asks to remember them, the wording clearly describes a general future preference, or the surrounding pattern strongly implies a recurring durable preference or rapport detail.",
      "Keep each memory concise and structured as one short durable fact or preference. Normal memory should be one sentence; dense memories may replace several near-duplicate rows, but should still stay short, around <=350 chars unless explicitly asked to preserve detailed instructions.",
      "Call this tool at most once per pass; put all memory changes in the single actions array.",
      "Before creating a new memory, check whether an existing memory should be updated, compressed, or deleted instead. If a new memory overlaps an existing one, update that id with a shorter merged version instead of creating another row.",
      "Actively delete stale or superseded existing memories when the current exchange clearly replaces them.",
      "Do not store the same underlying memory in multiple scopes.",
      "Prefer the narrowest correct scope: subject=current_user for triggering-user preferences/facts, subject=user with username for another Discord user, and subject=global only for shared server/project facts or explicit bot-wide rules. Do not turn one user's preference into a global memory unless explicitly asked to apply it globally/everyone.",
      "Set expiresAt only for clearly temporary memories, such as current-event context, short-lived projects, temporary availability, deadlines, or explicitly time-limited preferences. Use future Unix epoch milliseconds based on the current time provided in context; never use past timestamps or seconds. Do not set expiry for names, pronouns, stable preferences, relationships, durable facts, or things likely to live a long time.",
      "Set expiresAt=null on an existing id to clear expiry when a temporary memory becomes permanent; set a later expiresAt to prolong temporary context.",
      "When recording a claim about another user that they did not directly confirm, use lower confidence.",
      "When saving personal knowledge as global, include the person's name or the group scope in the content so future turns are not ambiguous.",
    ].join(" "),
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
        content: [{ type: "text", text: `Memory update complete. Applied ${applied} of ${extraction.actions.length} requested action(s).` }],
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
    text: "You are a memory extraction routine. Return only JSON matching the schema.",
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
