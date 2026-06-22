import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
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
    subject: Type.Union([Type.Literal("global"), Type.Literal("current_user"), Type.Literal("user")], {
      description: "global for shared context, current_user for the triggering user, user for another Discord user.",
    }),
    username: Type.Optional(Type.String({
      minLength: 1,
      description: "Required when subject=user. Leading @ is optional.",
    })),
    kind: Type.String({ enum: [...MEMORY_KINDS] }),
    content: Type.String({ minLength: 1 }),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
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
      expiresIn?: ExpiresIn | null;
    }
    | { action: "delete"; id: number }
  >;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scopeLabel(row: MemoryRow, resolveUserId?: (userId: string) => string | undefined): string {
  if (row.subjectUserId === null) return row.guildId !== null ? `guild:${row.guildId}` : "guild";
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
    "Preserve a memory only if it is likely to be useful in a future conversation or future bot decision.",
    "If the fact cannot change how the bot should reply or act later, return action=none.",
    "Save stable user preferences, identity details, hard constraints, recurring interests, relationships, long-term facts, and explicit corrections.",
    "Record explicit and strongly implied durable facts, preferences, relationships, routines, constraints, identity details, interests, and recurring behaviors when they could matter later; the user does not need to ask you to remember.",
    "The triggering user is only the source of this memory pass, not the only valid memory subject. Inspect the current exchange and recent chat context for durable, future-useful memories about any clearly identifiable user or shared context; use subject=user with username for another user when appropriate.",
    "Be proactive but selective: record context-derived or implied memories only when they are likely to affect future replies, reveal a stable pattern, or clarify relationships, preferences, constraints, interests, identity, active work, or routines.",
    "Memory changes should be occasional, not routine. Prefer action=none when the signal is weak, incidental, or unlikely to matter in future conversations.",
    "For subtle, uncertain, or pattern-based memories, use lower confidence and tentative standalone phrasing; if the clue is likely to become stale, use a conservative expiresIn. Keep the memory content short and avoid verbose meta-commentary.",
    "Use lower confidence for indirect, inferred, or pattern-based memories.",
    "Write each memory as a standalone factual note that remains clear without hidden chat context, prior assumptions, or what the bot previously believed.",
    "Keep memory content tiny and atomic. Most memories should be under 160 characters; use up to 220 characters only for explicit multi-part user instructions. Never summarize a conversation.",
    "Do not save jokes, transient moods, ordinary chat, pleasantries, reactions, filler, or one-off requests.",
    "When in doubt, do not save it.",
    "Do not record preferences that only apply to the current request unless the user asks to remember them, the wording clearly describes a general future preference, or the surrounding pattern strongly implies a recurring durable preference or rapport detail.",
    "Before creating a new memory, check whether an existing memory should be updated, compressed, or deleted instead.",
    "Do not store the same underlying memory in multiple scopes. If a new memory overlaps an existing one, update that existing id with a shorter merged version instead of creating another row.",
    "Update an existing memory id only when the new chat meaningfully changes its facts, confidence, expiry, or merges/removes a real duplicate. Do not update just to improve grammar, phrasing, capitalization, tense, style, or specificity.",
    "Prefer updating an existing memory id over creating duplicates when there is a real semantic change. Actively delete stale or superseded existing memories when the current exchange clearly replaces them.",
    "Only delete a memory when an existing memory is listed below and the new chat clearly makes that specific memory obsolete, false, or superseded. Never invent memory ids.",
    "User-scoped memories are Discord-user memories and are visible across guilds. If a user fact/preference only applies in the current guild or channel, keep the content explicit about that guild/channel by name or ID.",
    "subject=global means a shared memory for the current guild/server, not a cross-guild bot-wide memory.",
    "Prefer the narrowest correct scope: subject=current_user for triggering-user preferences/facts, subject=user with username for another named user, and subject=global only for shared current-server facts or explicit current-server bot rules.",
    "Do not turn one user's preference into a global memory unless explicitly asked to apply it globally or to everyone.",
    "Use kind=identity for names, pronouns, languages, timezones, roles, handles, or stable self-descriptions.",
    "Use kind=constraint for hard boundaries, privacy limits, standing requirements, do-not-do rules, and durable constraints on bot behavior.",
    "Use kind=interest for recurring hobbies, tastes, subjects, media, activities, or preference-like interests that are not direct behavior instructions.",
    "Use kind=scratchpad only for very short-lived internal notes that help the bot reason across immediate follow-up turns. Scratchpad is private working context, not user-facing memory.",
    "Scratchpad is not a progress dump, transcript summary, or activity log. Do not save facts that message history can already recover; save only the tiny hidden note needed for the next iteration.",
    "Scratchpad must always include expiresIn when created or when converted from another kind. Use minutes or hours; at most 1 day. Update expiresIn to reset the short TTL only while the note remains useful.",
    "Set expiresIn only for clearly temporary memories, such as current-event context, scratchpad, temporary availability, deadlines, or explicitly time-limited preferences. Use a structured relative duration like {amount: 3, unit: \"days\"}; do not calculate timestamps.",
    "Do not overuse expiresIn except for scratchpad. Do not set expiry for names, pronouns, stable preferences, relationships, durable facts, constraints, identity details, or things likely to live a long time; permanent is fine because stale memories can be removed later.",
    "When a temporary memory is reinforced into a permanent memory, set expiresIn=null on that existing id. When temporary context is extended, update expiresIn to the full new relative duration from now.",
    "Do not persist facts that come only from system/developer context, persona, tool instructions, existing memory text, member lists, schedules, or bot implementation details.",
    "Focus on what the human user newly revealed or corrected in the chat exchange. Recent chat context is supporting evidence, not the only source.",
    "If the user asks to remember something, treat that as strong intent to preserve the underlying fact/preference if it can matter later.",
    "If the bot reply says it will remember something, do not save the promise itself; save the user's underlying fact/preference when it is future-useful.",
    "Save rapport, teasing, tone, or help preferences only when the user clearly revealed a durable preference or relationship fact.",
    "Do not save trivia just because it is interesting.",
    "If the user says their name, preferred name, or corrects what they should be called, preserve it as current_user unless it is obviously a joke or roleplay.",
  ];
}

/** Build the uncached memory block injected into the conversation prompt. */
export function buildMemoryContext(input: MemoryContextInput): string {
  const limit = input.limit ?? 80;
  const total = countMemories(input.db, {
    guildId: input.guildId,
    subjectUserId: input.currentUserId,
    includeGlobal: true,
  });
  const rows = listMemories(input.db, {
    guildId: input.guildId,
    subjectUserId: input.currentUserId,
    includeGlobal: true,
    limit,
  }).filter((row) => row.content.trim() !== "");

  if (rows.length === 0) return "";

  const lines = [...rows].reverse().map((row) => {
    const label = scopeLabel(row, input.resolveUserId);
    const expiry = row.expiresAt !== null ? ` [${formatExpiry(row.expiresAt)}]` : "";
    return `- ${row.id} [${label}] [${formatConfidence(row.confidence)}] [${row.kind}]${expiry} ${row.content}`;
  });
  return [
    `Showing ${rows.length}/${total} memories.`,
    "Use as background context; current chat instructions override memory. Number after scope is confidence (0-1). Newer/relevant memories are closer to the bottom.",
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

  const lines = [
    "## Existing Memories For Other Visible Users",
    "These memories are shown only so this memory pass can update existing rows or avoid duplicates for other users visible in the rendered chat history. Do not copy them into new memories unless the current exchange adds new information. Fresher memories and users with more recent visible activity are lower in this section.",
  ];
  for (const group of [...groups].reverse()) {
    const username = input.resolveUserId?.(group.userId);
    const label = username !== undefined && username !== "" ? `@${username}` : `user:${group.userId}`;
    lines.push(`### ${label}`);
    for (const row of [...group.rows].reverse()) {
      const expiry = row.expiresAt !== null ? ` [${formatExpiry(row.expiresAt)}]` : "";
      lines.push(`- ${row.id} [${formatConfidence(row.confidence)}] [${row.kind}]${expiry} ${row.content}`);
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
  if (value === "user" || value === "other_user" || value === "username") return "user";
  if (typeof value === "string" && value.trim().startsWith("@")) return "user";
  return "current_user";
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
                    subject: { type: "string", enum: ["global", "current_user", "user"] },
                    username: { type: "string", minLength: 1 },
                    kind: { type: "string", enum: [...MEMORY_KINDS] },
                    content: { type: "string", minLength: 1 },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
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
    `Current user: @${input.currentUsername} (${input.currentUserId})`,
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
  subjectUserId: string | null,
  kind: MemoryKind,
  content: string,
): MemoryRow | null {
  const normalized = content.trim().toLowerCase();
  const rows = listMemories(input.db, {
    guildId: input.guildId,
    subjectUserId,
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
    if (!scratchpadExpiryIsValid(action, existing)) continue;
    const expiresAt = action.expiresIn === undefined
      ? undefined
      : action.expiresIn === null
        ? null
        : expiresInToExpiresAt(action.expiresIn);
    const payload = {
      subjectUserId,
      kind: action.kind,
      content: action.content.trim(),
      sourceMessageId: input.sourceMessageId,
      confidence: action.confidence,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
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
      "Record durable memory updates or short-lived scratchpad updates after a Discord turn has already completed.",
      ...buildMemoryPolicyInstructions(),
      "Call this tool at most once per pass; put all memory changes in the single actions array.",
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
