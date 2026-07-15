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
  listMemoryMaintenanceBatch,
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

export interface MemoryMaintenanceContextInput {
  db: Database;
  guildId: string;
  afterId: number;
  limit: number;
  resolveUserId?: (userId: string) => string | undefined;
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
const DEFAULT_CROSS_SUBJECT_APPLICABLE_ROWS = 10;

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

const MemoryAppliesToSchema = Type.Union([
  Type.Literal("all", { description: "Relevant regardless of which users are present." }),
  Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description: "Exact usernames whose presence makes this memory relevant.",
  }),
]);

const MemoryWriteProperties = {
  subject: Type.Union([Type.Literal("global"), Type.Literal("user"), Type.Literal("self")], {
    description: "What or whom the memory is about; independent from applies_to.",
  }),
  username: Type.Optional(Type.String({ minLength: 1, description: "Username for subject=user." })),
  applies_to: MemoryAppliesToSchema,
  kind: Type.String({ enum: [...MEMORY_KINDS] }),
  content: Type.String({ minLength: 1 }),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  important: Type.Optional(Type.Boolean()),
  expiresIn: Type.Optional(Type.Union([ExpiresInSchema, Type.Null()], {
    description: "Relative duration for clearly temporary memories; null clears an existing expiry.",
  })),
};

const MemoryWriteActionSchema = Type.Union([
  Type.Object({
    action: Type.Literal("create"),
    ...MemoryWriteProperties,
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("update"),
    id: Type.Integer({ minimum: 1 }),
    ...MemoryWriteProperties,
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
  actions: Type.Array(MemoryActionSchema, { maxItems: 20 }),
}, { additionalProperties: false });

const RecordMemoryToolSchema = Type.Object({
  actions: Type.Array(MemoryWriteActionSchema, { minItems: 1, maxItems: 20 }),
}, { additionalProperties: false });

type MemoryExtraction = {
  actions: Array<
    | { action: "none" }
    | {
      action: "create" | "update";
      id?: number;
      subject: MemorySubject;
      username?: string;
      applies_to: "all" | string[];
      kind: MemoryKind;
      content: string;
      confidence?: number;
      important?: boolean;
      expiresIn?: ExpiresIn | null;
    }
    | { action: "delete"; id: number }
  >;
};

type MemoryWriteAction = Extract<MemoryExtraction["actions"][number], { subject: MemorySubject }>;

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
  if (row.appliesTo === "all") return " [applies:all]";
  const labels = row.appliesTo.map((userId) => {
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

/** Build one rotating stored-memory slice for ambient corpus maintenance. */
export function buildMemoryMaintenanceContext(input: MemoryMaintenanceContextInput): {
  text: string;
  nextCursorId: number;
} {
  const batch = listMemoryMaintenanceBatch(input.db, {
    guildId: input.guildId,
    afterId: input.afterId,
    limit: input.limit,
  });
  if (batch.rows.length === 0) return { text: "", nextCursorId: batch.nextCursorId };
  return {
    text: [
      "## Rotating Memory Maintenance Candidates",
      "Review these stored rows independently of the current chat. Repair, split, consolidate, or delete them when their clean durable structure is clear; otherwise leave them unchanged.",
      ...batch.rows.map((row) => formatMemoryRow(row, input.guildId, input.resolveUserId)),
    ].join("\n"),
    nextCursorId: batch.nextCursorId,
  };
}

function memoryClockContext(timezone: string | undefined, now = Date.now()): string {
  const tz = timezone ?? "UTC";
  return currentLocalContext(tz, now);
}

/** Shared policy for memory-writing prompts and the record_memory tool. */
export function buildMemoryPolicyInstructions(): string[] {
  return [
    "Preserve only durable, future-useful memory and choose the cleanest focused row structure rather than minimizing mutations.",
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
  const crossSubjectLimit = Math.min(
    DEFAULT_CROSS_SUBJECT_APPLICABLE_ROWS,
    Math.max(0, limit - recentRows.length - 1),
  );
  const excludedCrossSubjects = [input.currentUserId, ...recentGroups.map((group) => group.userId)];
  const crossSubjectTotal = countMemories(input.db, {
    guildId: input.guildId,
    scope: "user",
    applicableToUserIds: applicableUserIds,
    excludeSubjectUserIds: excludedCrossSubjects,
  });
  const crossSubjectRows = crossSubjectLimit > 0
    ? listMemories(input.db, {
        guildId: input.guildId,
        scope: "user",
        applicableToUserIds: applicableUserIds,
        excludeSubjectUserIds: excludedCrossSubjects,
        limit: crossSubjectLimit,
      })
    : [];
  const primaryLimit = Math.max(0, limit - recentRows.length - crossSubjectRows.length);
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
  const total = conversationalTotal + selfTotal + recentTotal + crossSubjectTotal;
  const rows = [...conversationalRows, ...selfRows, ...crossSubjectRows]
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
  const showingLine = recentTotal > 0 || crossSubjectTotal > 0
    ? `Showing ${rows.length + recentRows.length}/${total} memories (${conversationalRows.length}/${conversationalTotal} guild/current user, ${selfRows.length}/${selfTotal} self, ${recentRows.length}/${recentTotal} recent speakers, ${crossSubjectRows.length}/${crossSubjectTotal} cross-subject applicable).`
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
      applicableToUserIds: [input.currentUserId, ...input.visibleUserIds],
      limit: rowLimit,
    });
    if (rows.length === 0) continue;

    groups.push({
      userId,
      rows,
      total: countMemories(input.db, {
        guildId: input.guildId,
        subjectUserId: userId,
        applicableToUserIds: [input.currentUserId, ...input.visibleUserIds],
      }),
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
      lines.push(`- ${row.id}${applicabilityLabel(row, input.resolveUserId)} [${formatConfidence(row.confidence)}] [${row.kind}]${row.priority > 0 ? " [IMPORTANT]" : ""}${expiry} ${row.content}`);
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

function normalizeAppliesTo(
  value: unknown,
  subject: MemorySubject,
  username: string | undefined,
): "all" | string[] | undefined {
  if (value === "all") return "all";
  const usernames = normalizeUsernameList(value);
  if (usernames !== undefined && usernames.length > 0) return usernames;
  if (value !== undefined) return undefined;
  return subject === "user" && username !== undefined ? [username] : "all";
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
  action: MemoryWriteAction,
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
    const subject = normalizeSubject(value.subject);
    const username = normalizeUsername(value.username ?? value.subject);
    const appliesTo = normalizeAppliesTo(value.applies_to, subject, username);
    if (appliesTo === undefined) return null;
    const action = rawAction === "update" || (rawAction === "upsert" && id !== undefined) ? "update" : "create";
    if (action === "update" && id === undefined) return null;
    return {
      action,
      ...(action === "update" && id !== undefined ? { id } : {}),
      subject,
      ...(username !== undefined ? { username } : {}),
      applies_to: appliesTo,
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
    .slice(0, 20)
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
            maxItems: 20,
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
                  required: ["action", "subject", "applies_to", "kind", "content"],
                  properties: {
                    action: { const: "create" },
                    subject: { type: "string", enum: ["global", "user", "self"] },
                    username: { type: "string", minLength: 1 },
                    applies_to: {
                      anyOf: [
                        { const: "all" },
                        { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
                      ],
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
                  required: ["action", "id", "subject", "applies_to", "kind", "content"],
                  properties: {
                    action: { const: "update" },
                    id: { type: "integer", minimum: 1 },
                    subject: { type: "string", enum: ["global", "user", "self"] },
                    username: { type: "string", minLength: 1 },
                    applies_to: {
                      anyOf: [
                        { const: "all" },
                        { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
                      ],
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
    "If Existing memories is (none), deletion and update are impossible; return none or create only.",
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

interface MemoryActionTarget {
  scope: MemoryScope;
  subjectUserId: string | null;
}

async function resolveUserReference(
  input: MemoryMutationInput,
  username: string,
): Promise<string> {
  const normalized = normalizeUsername(username);
  if (normalized === undefined) throw new Error("Memory user reference cannot be empty.");
  if (input.currentUsername !== undefined && normalized.toLowerCase() === input.currentUsername.toLowerCase()) {
    return input.currentUserId;
  }
  const explicitId = /^(?:user:)?(\d{17,20})$/.exec(normalized)?.[1];
  if (explicitId !== undefined) return explicitId;
  const userId = await input.resolveUsername?.(normalized);
  if (userId === undefined) throw new Error(`Could not resolve memory user @${normalized}.`);
  return userId;
}

async function resolveApplicability(
  input: MemoryMutationInput,
  appliesTo: "all" | readonly string[],
): Promise<"all" | string[]> {
  if (appliesTo === "all") return "all";
  const userIds: string[] = [];
  for (const username of appliesTo) userIds.push(await resolveUserReference(input, username));
  return [...new Set(userIds)];
}

async function actionMemoryTarget(
  input: MemoryMutationInput,
  action: MemoryWriteAction,
): Promise<MemoryActionTarget> {
  if (action.subject === "self") return { scope: "self", subjectUserId: null };
  if (action.subject === "global") return { scope: "guild", subjectUserId: null };

  const username = normalizeUsername(action.username);
  if (username === undefined) throw new Error("User-subject memories require username.");
  return { scope: "user", subjectUserId: await resolveUserReference(input, username) };
}

type PreparedMemoryMutation =
  | { action: "create"; input: Parameters<typeof createMemory>[1] }
  | { action: "update"; id: number; input: Parameters<typeof updateMemory>[2] }
  | { action: "delete"; id: number };

async function prepareMemoryActions(
  input: MemoryMutationInput,
  extraction: MemoryExtraction,
): Promise<PreparedMemoryMutation[]> {
  const prepared: PreparedMemoryMutation[] = [];
  const mutatedIds = new Set<number>();
  for (const action of extraction.actions) {
    if (action.action === "none") continue;
    if (action.action === "delete") {
      if (editableMemory(input, action.id) === null) throw new Error(`Memory ${action.id} is not editable from this guild.`);
      if (mutatedIds.has(action.id)) throw new Error(`Memory ${action.id} has multiple mutations in one batch.`);
      mutatedIds.add(action.id);
      prepared.push(action);
      continue;
    }

    const existing = action.action === "update" && action.id !== undefined ? editableMemory(input, action.id) : null;
    if (action.action === "update" && (action.id === undefined || existing === null)) {
      throw new Error(`Memory ${action.id ?? "(missing id)"} is not editable from this guild.`);
    }
    if (action.action === "update" && action.id !== undefined) {
      if (mutatedIds.has(action.id)) throw new Error(`Memory ${action.id} has multiple mutations in one batch.`);
      mutatedIds.add(action.id);
    }

    const target = await actionMemoryTarget(input, action);
    const appliesTo = await resolveApplicability(input, action.applies_to);
    if (!memoryKindScopeIsValid(action.kind, target.scope)) throw new Error("Journal memories require self subject.");
    if (!scratchpadExpiryIsValid(action, existing)) throw new Error("Scratchpad memories require expiresIn of at most one day.");
    const expiresAt = action.expiresIn === undefined
      ? undefined
      : action.expiresIn === null
        ? null
        : expiresInToExpiresAt(action.expiresIn);
    const common = {
      scope: target.scope,
      ...(target.scope === "guild" ? { guildId: input.guildId } : {}),
      subjectUserId: target.subjectUserId,
      appliesTo,
      kind: action.kind,
      content: action.content.trim(),
      confidence: action.confidence,
      ...(action.important !== undefined ? { priority: action.important ? 1 : 0 } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    if (common.content === "") throw new Error("Memory content cannot be empty.");

    if (action.action === "update" && action.id !== undefined) {
      prepared.push({ action: "update", id: action.id, input: common });
    } else {
      prepared.push({
        action: "create",
        input: {
          guildId: input.guildId,
          ...common,
          sourceMessageId: input.sourceMessageId,
          provenance: {
            sourceMessageIds: [input.sourceMessageId],
            guildId: input.guildId,
            userId: input.currentUserId,
            capturedAt: Date.now(),
          },
        },
      });
    }
  }
  return prepared;
}

async function applyMemoryActions(
  input: MemoryMutationInput,
  extraction: MemoryExtraction,
  dryRun = false,
): Promise<number> {
  const prepared = await prepareMemoryActions(input, extraction);
  const savepoint = `memory_batch_${crypto.randomUUID().replaceAll("-", "")}`;
  input.db.raw.run(`SAVEPOINT ${savepoint}`);
  try {
    for (const mutation of prepared) {
      if (mutation.action === "create") {
        createMemory(input.db, mutation.input);
      } else if (mutation.action === "update") {
        if (!updateMemory(input.db, mutation.id, mutation.input)) throw new Error(`Memory ${mutation.id} disappeared during update.`);
      } else if (!deleteMemory(input.db, mutation.id)) {
        throw new Error(`Memory ${mutation.id} disappeared during deletion.`);
      }
    }
    if (dryRun) input.db.raw.run(`ROLLBACK TO ${savepoint}`);
    input.db.raw.run(`RELEASE ${savepoint}`);
    return prepared.length;
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
      if (!Value.Check(RecordMemoryToolSchema, params)) {
        return {
          content: [{ type: "text", text: "Memory update rejected: arguments did not match the schema." }],
          details: { error: true },
        };
      }

      const extraction = params as MemoryExtraction;
      try {
        const applied = await applyMemoryActions(deps, extraction, deps.dryRun === true);
        return {
          content: [{ type: "text", text: `Memory update complete; applied ${applied} of ${extraction.actions.length} requested action(s).` }],
          details: { applied, requested: extraction.actions.length },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Memory update rejected: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
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
