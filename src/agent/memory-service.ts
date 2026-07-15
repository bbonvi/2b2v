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
  /** Human users visible in rendered history, newest visible activity first. */
  visibleUserIds?: readonly string[];
  resolveUserId?: (userId: string) => string | undefined;
  limit?: number;
  recentUserMaxUsers?: number;
  recentUserMaxMemoriesPerUser?: number;
  recentUserMaxRows?: number;
  contextInstruction?: string;
}

interface VisibleUserMemorySelectionInput {
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

export interface VisibleUserMemoryContextInput extends VisibleUserMemorySelectionInput {
  contextInstruction?: string;
}

interface VisibleUserMemoryGroup {
  userId: string;
  rows: MemoryRow[];
  total: number;
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
  /** Run validation and result counting without persisting changes. */
  dryRun?: boolean;
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
const DEFAULT_RECENT_USER_MAX_USERS = 3;
const DEFAULT_RECENT_USER_MAX_MEMORIES = 2;
const DEFAULT_RECENT_USER_MAX_ROWS = 6;

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

const MemoryWriteActionSchema = Type.Union([
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
    applies_to: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
      maxItems: 20,
      description: "Users whose presence makes this memory relevant; this does not change its subject.",
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

const MemoryActionSchema = Type.Union([
  Type.Object({
    action: Type.Literal("none"),
  }, { additionalProperties: false }),
  MemoryWriteActionSchema,
]);

const MemoryExtractionSchema = Type.Object({
  actions: Type.Array(MemoryActionSchema, { maxItems: 5 }),
}, { additionalProperties: false });

const RecordMemoryToolSchema = Type.Object({
  actions: Type.Array(MemoryWriteActionSchema, { minItems: 1, maxItems: 5 }),
}, { additionalProperties: false });

type MemoryExtraction = {
  actions: Array<
    | { action: "none" }
    | {
      action: "upsert";
      id?: number;
      subject: MemorySubject;
      username?: string;
      applies_to?: string[];
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

function applicabilityLabel(row: MemoryRow, resolveUserId?: (userId: string) => string | undefined): string {
  const nonSubjectIds = row.appliesToUserIds.filter((userId) => userId !== row.subjectUserId);
  if (nonSubjectIds.length === 0) return "";
  const labels = nonSubjectIds.map((userId) => {
    const username = resolveUserId?.(userId);
    return username !== undefined && username !== "" ? `@${username}` : `user:${userId}`;
  });
  return ` [applies:${labels.join(",")}]`;
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

function formatMemoryRow(
  row: MemoryRow,
  currentGuildId: string,
  resolveUserId?: (userId: string) => string | undefined,
): string {
  const expiry = row.expiresAt !== null ? ` [${formatExpiry(row.expiresAt)}]` : "";
  return `- ${row.id} [${scopeLabel(row, currentGuildId, resolveUserId)}]${applicabilityLabel(row, resolveUserId)} [${formatConfidence(row.confidence)}] [${row.kind}]${row.priority > 0 ? " [IMPORTANT]" : ""}${expiry} ${row.content}`;
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
  const applicableUserIds = [...new Set([input.currentUserId, ...(input.visibleUserIds ?? [])])];
  const recentGroups = input.visibleUserIds === undefined
    ? []
    : selectVisibleUserMemoryGroups({
        db: input.db,
        guildId: input.guildId,
        currentUserId: input.currentUserId,
        visibleUserIds: input.visibleUserIds,
        maxUsers: input.recentUserMaxUsers ?? DEFAULT_RECENT_USER_MAX_USERS,
        maxMemoriesPerUser: input.recentUserMaxMemoriesPerUser ?? DEFAULT_RECENT_USER_MAX_MEMORIES,
        maxRows: Math.min(
          input.recentUserMaxRows ?? DEFAULT_RECENT_USER_MAX_ROWS,
          Math.max(0, limit - 1),
        ),
      });
  const recentRows = recentGroups.flatMap((group) => group.rows);
  const recentTotal = recentGroups.reduce((total, group) => total + group.total, 0);
  const primaryLimit = Math.max(0, limit - recentRows.length);
  const maxSelfLimit = Math.min(primaryLimit, 30);
  const selfTotal = countMemories(input.db, {
    guildId: input.guildId,
    scope: "self",
    applicableToUserIds: applicableUserIds,
  });
  const selfRows = listMemories(input.db, {
    guildId: input.guildId,
    scope: "self",
    applicableToUserIds: applicableUserIds,
    limit: maxSelfLimit,
  }).filter((row) => row.content.trim() !== "");
  const conversationalLimit = Math.max(0, primaryLimit - selfRows.length);
  const conversationalTotal = countMemories(input.db, {
    guildId: input.guildId,
    subjectUserId: input.currentUserId,
    includeGlobal: true,
    applicableToUserIds: applicableUserIds,
  });
  const conversationalRows = conversationalLimit > 0
    ? listMemories(input.db, {
        guildId: input.guildId,
        subjectUserId: input.currentUserId,
        includeGlobal: true,
        applicableToUserIds: applicableUserIds,
        limit: conversationalLimit,
      }).filter((row) => row.content.trim() !== "")
    : [];
  const total = conversationalTotal + selfTotal + recentTotal;
  const rows = [...conversationalRows, ...selfRows]
    .sort((a, b) => {
      const priorityDiff = a.priority - b.priority;
      if (priorityDiff !== 0) return priorityDiff;
      const updatedDiff = a.updatedAt - b.updatedAt;
      return updatedDiff !== 0 ? updatedDiff : a.id - b.id;
    });

  if (rows.length === 0 && recentRows.length === 0) return "";

  const lines = rows.map((row) => formatMemoryRow(row, input.guildId, input.resolveUserId));
  const recentLines = [...recentGroups].reverse().flatMap((group) => [...group.rows]
    .reverse()
    .map((row) => formatMemoryRow(row, input.guildId, input.resolveUserId)));
  const showingLine = recentTotal > 0
    ? `Showing ${rows.length + recentRows.length}/${total} memories (${conversationalRows.length}/${conversationalTotal} guild/current user, ${selfRows.length}/${selfTotal} self, ${recentRows.length}/${recentTotal} recent speakers).`
    : selfTotal > 0
    ? `Showing ${rows.length}/${total} memories (${conversationalRows.length}/${conversationalTotal} guild/user, ${selfRows.length}/${selfTotal} self).`
    : `Showing ${rows.length}/${total} memories.`;
  const contextInstruction = input.contextInstruction?.trim() !== ""
    ? input.contextInstruction ?? "Use memory as background context."
    : "Use memory as background context.";
  return [
    showingLine,
    contextInstruction,
    ...lines,
    ...(recentGroups.length > 0
      ? [
          "Recent speaker memories apply only to their named subject; use them when relevant and do not spill person-specific context onto others.",
          ...recentLines,
        ]
      : []),
  ].join("\n");
}

/** Select bounded user-memory groups for recent visible human speakers. */
function selectVisibleUserMemoryGroups(input: VisibleUserMemorySelectionInput): VisibleUserMemoryGroup[] {
  const maxUsers = Math.max(0, Math.trunc(input.maxUsers ?? 10));
  const maxMemoriesPerUser = Math.max(0, Math.trunc(input.maxMemoriesPerUser ?? 10));
  const maxRows = Math.max(0, Math.trunc(input.maxRows ?? 100));
  if (maxUsers === 0 || maxMemoriesPerUser === 0 || maxRows === 0) return [];

  const seen = new Set<string>([input.currentUserId]);
  const groups: VisibleUserMemoryGroup[] = [];
  let rowCount = 0;

  for (const userId of input.visibleUserIds) {
    if (groups.length >= maxUsers || rowCount >= maxRows) break;
    if (seen.has(userId)) continue;
    seen.add(userId);

    const remainingRows = maxRows - rowCount;
    const rowLimit = Math.min(maxMemoriesPerUser, remainingRows);
    const rows = listMemories(input.db, {
      guildId: input.guildId,
      subjectUserId: userId,
      limit: rowLimit,
    });
    if (rows.length === 0) continue;

    groups.push({
      userId,
      rows,
      total: countMemories(input.db, { guildId: input.guildId, subjectUserId: userId }),
    });
    rowCount += rows.length;
  }
  return groups;
}

/** Build memory-pass-only dedupe context for other users visible in chat history. */
export function buildVisibleUserMemoryContext(input: VisibleUserMemoryContextInput): string {
  const groups = selectVisibleUserMemoryGroups(input);

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

function normalizeUsernameList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value
    .map((entry) => normalizeUsername(entry))
    .filter((entry): entry is string => entry !== undefined))];
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
      ...(normalizeUsernameList(value.applies_to) !== undefined
        ? { applies_to: normalizeUsernameList(value.applies_to) }
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
                    applies_to: {
                      type: "array",
                      maxItems: 20,
                      items: { type: "string", minLength: 1 },
                    },
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

async function resolveApplicableUserIds(
  input: MemoryMutationInput,
  usernames: readonly string[] | undefined,
): Promise<string[] | undefined> {
  if (usernames === undefined) return undefined;
  const userIds: string[] = [];
  for (const username of usernames) {
    if (input.currentUsername !== undefined && username.toLowerCase() === input.currentUsername.toLowerCase()) {
      userIds.push(input.currentUserId);
      continue;
    }
    if (input.resolveUsername === undefined) return undefined;
    const userId = await input.resolveUsername(username);
    if (userId === undefined) return undefined;
    userIds.push(userId);
  }
  return [...new Set(userIds)];
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
    const appliesToUserIds = await resolveApplicableUserIds(input, action.applies_to);
    if (action.applies_to !== undefined && appliesToUserIds === undefined) continue;
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
      ...(appliesToUserIds !== undefined ? { appliesToUserIds } : {}),
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
      const mergedAppliesToUserIds = appliesToUserIds === undefined
        ? undefined
        : [...new Set([...duplicate.appliesToUserIds, ...appliesToUserIds])];
      if ((action.important === true && duplicate.priority < 1) || mergedAppliesToUserIds !== undefined) {
        updateMemory(input.db, duplicate.id, {
          ...(action.important === true && duplicate.priority < 1 ? { priority: 1 } : {}),
          ...(mergedAppliesToUserIds !== undefined ? { appliesToUserIds: mergedAppliesToUserIds } : {}),
        });
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

async function applyMemoryActionsDryRun(input: MemoryMutationInput, extraction: MemoryExtraction): Promise<number> {
  const savepoint = `memory_dry_run_${crypto.randomUUID().replaceAll("-", "")}`;
  input.db.raw.run(`SAVEPOINT ${savepoint}`);
  try {
    const applied = await applyMemoryActions(input, extraction);
    input.db.raw.run(`ROLLBACK TO ${savepoint}`);
    input.db.raw.run(`RELEASE ${savepoint}`);
    return applied;
  } catch (error) {
    try {
      input.db.raw.run(`ROLLBACK TO ${savepoint}`);
      input.db.raw.run(`RELEASE ${savepoint}`);
    } catch {
      // Preserve the original tool failure if rollback cleanup itself fails.
    }
    throw error;
  }
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
    parameters: RecordMemoryToolSchema,

    async execute(_toolCallId: string, params: unknown): Promise<RecordMemoryToolResult> {
      const normalized = normalizeExtractionShape(params);
      if (!Value.Check(RecordMemoryToolSchema, normalized)) {
        return {
          content: [{ type: "text", text: "Memory update rejected: arguments did not match the schema." }],
          details: { error: true },
        };
      }

      const extraction = normalized as MemoryExtraction;
      const applied = deps.dryRun === true
        ? await applyMemoryActionsDryRun(deps, extraction)
        : await applyMemoryActions(deps, extraction);
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
