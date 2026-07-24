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
  type MemoryAbout,
  type MemoryKind,
  type MemoryRow,
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
  /** Strong positive relationship users whose memories remain relevant while absent. */
  relationshipAnchorUserIds?: readonly string[];
  resolveUserId?: (userId: string) => string | undefined;
  limit?: number;
  recentUserMaxUsers?: number;
  recentUserMaxMemoriesPerUser?: number;
  recentUserMaxRows?: number;
  contextInstruction?: string;
}

export interface PrivateLifeMemoryContextInput {
  db: Database;
  guildId: string;
  notableUserIds: readonly string[];
  resolveUserId?: (userId: string) => string | undefined;
  limit?: number;
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

/**
 * Keep important rows visible without allowing them to hide every recently
 * changed normal row for the same user.
 */
function selectReservedUserMemoryRows(rows: readonly MemoryRow[], limit: number): MemoryRow[] {
  if (limit <= 0) return [];
  if (limit === 1) return rows.slice(0, 1);

  const importantLimit = Math.ceil(limit / 2);
  const recentNormalLimit = Math.floor(limit / 2);
  const selectedIds = new Set<number>();
  const selected: MemoryRow[] = [];
  const add = (row: MemoryRow): void => {
    if (selectedIds.has(row.id) || selected.length >= limit) return;
    selectedIds.add(row.id);
    selected.push(row);
  };

  for (const row of rows.filter((candidate) => candidate.priority > 0).slice(0, importantLimit)) add(row);
  for (const row of rows.filter((candidate) => candidate.priority <= 0).slice(0, recentNormalLimit)) add(row);
  for (const row of rows) add(row);

  const rank = new Map(rows.map((row, index) => [row.id, index]));
  return selected.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
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

type MemoryRecallInInput = "anywhere" | "current_guild";
type MemoryRecallWhenInput = "always" | { users_present: string[] };
type ExpiresInUnit = "minutes" | "hours" | "days" | "weeks" | "months";
const MAX_SCRATCHPAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RECENT_USER_MAX_USERS = 3;
const DEFAULT_RECENT_USER_MAX_MEMORIES = 4;
const DEFAULT_RECENT_USER_MAX_ROWS = 12;
const DEFAULT_CROSS_SUBJECT_RELEVANT_ROWS = 10;
const DEFAULT_RELATIONSHIP_ANCHOR_MAX_USERS = 2;
const DEFAULT_RELATIONSHIP_ANCHOR_MAX_MEMORIES = 2;
const DEFAULT_RELATIONSHIP_ANCHOR_MAX_ROWS = 4;

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

const MemoryRecallWhenSchema = Type.Union([
  Type.Literal("always", { description: "Relevant regardless of which users are present." }),
  Type.Object({
    users_present: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: "Users whose presence makes this memory relevant; any match is sufficient.",
    }),
  }, { additionalProperties: false }),
]);

const MemoryWriteProperties = {
  about: Type.Union([Type.Literal("community"), Type.Literal("user"), Type.Literal("self")], {
    description: "What or whom the memory describes; independent from recall conditions.",
  }),
  username: Type.Optional(Type.String({ minLength: 1, description: "Username for about=user." })),
  kind: Type.String({ enum: [...MEMORY_KINDS] }),
  content: Type.String({ minLength: 1 }),
  source_message_id: Type.Optional(Type.Union([
    Type.String({ minLength: 1 }),
    Type.Null(),
  ])),
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
    recall_in: Type.Optional(Type.Union([Type.Literal("anywhere"), Type.Literal("current_guild")])),
    recall_when: Type.Optional(MemoryRecallWhenSchema),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("update"),
    id: Type.Integer({ minimum: 1 }),
    ...MemoryWriteProperties,
    recall_in: Type.Union([Type.Literal("anywhere"), Type.Literal("current_guild")]),
    recall_when: MemoryRecallWhenSchema,
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
      action: "create";
      about: MemoryAbout;
      username?: string;
      recall_in?: MemoryRecallInInput;
      recall_when?: MemoryRecallWhenInput;
      kind: MemoryKind;
      content: string;
      source_message_id?: string | null;
      confidence?: number;
      important?: boolean;
      expiresIn?: ExpiresIn | null;
    }
    | {
      action: "update";
      id: number;
      about: MemoryAbout;
      username?: string;
      recall_in: MemoryRecallInInput;
      recall_when: MemoryRecallWhenInput;
      kind: MemoryKind;
      content: string;
      source_message_id?: string | null;
      confidence?: number;
      important?: boolean;
      expiresIn?: ExpiresIn | null;
    }
    | { action: "delete"; id: number }
  >;
};

type MemoryWriteAction = Extract<MemoryExtraction["actions"][number], { about: MemoryAbout }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function aboutLabel(row: MemoryRow, resolveUserId?: (userId: string) => string | undefined): string {
  if (row.about !== "user" || row.aboutUserId === null) return row.about;
  const username = resolveUserId?.(row.aboutUserId);
  return username !== undefined && username !== "" ? `@${username}` : `user:${row.aboutUserId}`;
}

function recallLocationLabel(row: MemoryRow, currentGuildId: string): string {
  if (row.recallIn === "anywhere") return "anywhere";
  return row.recallIn.guildId === currentGuildId ? "this-guild" : `guild:${row.recallIn.guildId}`;
}

function recallTriggerLabel(row: MemoryRow, resolveUserId?: (userId: string) => string | undefined): string {
  if (row.recallWhen === "always") return "always";
  const labels = row.recallWhen.map((userId) => {
    const username = resolveUserId?.(userId);
    return username !== undefined && username !== "" ? `@${username}` : `user:${userId}`;
  });
  return `any(${labels.join(",")})`;
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

const MEMORY_AGE_BUCKETS = [
  { milliseconds: 60 * 1000, label: "1min" },
  { milliseconds: 60 * 60 * 1000, label: "1h" },
  { milliseconds: 6 * 60 * 60 * 1000, label: "6h" },
  { milliseconds: 24 * 60 * 60 * 1000, label: "1d" },
  { milliseconds: 3 * 24 * 60 * 60 * 1000, label: "3d" },
  { milliseconds: 5 * 24 * 60 * 60 * 1000, label: "5d" },
  { milliseconds: 7 * 24 * 60 * 60 * 1000, label: "1w" },
  { milliseconds: 14 * 24 * 60 * 60 * 1000, label: "2w" },
  { milliseconds: 30 * 24 * 60 * 60 * 1000, label: "1mo" },
  { milliseconds: 60 * 24 * 60 * 60 * 1000, label: "2mo" },
  { milliseconds: 90 * 24 * 60 * 60 * 1000, label: "3mo" },
  { milliseconds: 180 * 24 * 60 * 60 * 1000, label: "6mo" },
  { milliseconds: 365 * 24 * 60 * 60 * 1000, label: "1y" },
  { milliseconds: 2 * 365 * 24 * 60 * 60 * 1000, label: "2y+" },
] as const;

function formatMemoryAge(updatedAt: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - updatedAt);
  let closest: (typeof MEMORY_AGE_BUCKETS)[number] = MEMORY_AGE_BUCKETS[0];
  for (const bucket of MEMORY_AGE_BUCKETS.slice(1)) {
    if (Math.abs(elapsed - bucket.milliseconds) < Math.abs(elapsed - closest.milliseconds)) closest = bucket;
  }
  return closest.label;
}

function formatMemoryRow(
  row: MemoryRow,
  currentGuildId: string,
  resolveUserId?: (userId: string) => string | undefined,
): string {
  const age = ` [${formatMemoryAge(row.updatedAt)}]`;
  const expiry = row.expiresAt !== null ? ` [${formatExpiry(row.expiresAt)}]` : "";
  return `- ${row.id} [about:${aboutLabel(row, resolveUserId)}] [in:${recallLocationLabel(row, currentGuildId)}] [when:${recallTriggerLabel(row, resolveUserId)}] [${formatConfidence(row.confidence)}] [${row.kind}]${row.priority > 0 ? " [IMPORTANT]" : ""}${age}${expiry} ${row.content}`;
}

/** Render one self-contained memory search result without internal confidence. */
export function formatMemorySearchRow(
  row: MemoryRow,
  currentGuildId: string,
  resolveUserId?: (userId: string) => string | undefined,
): string {
  const age = ` [${formatMemoryAge(row.updatedAt)}]`;
  const expiry = row.expiresAt !== null ? ` [${formatExpiry(row.expiresAt)}]` : "";
  const source = row.sourceMessageId === null ? "" : ` [${row.sourceMessageId}]`;
  return `- ${row.id} [about:${aboutLabel(row, resolveUserId)}] [in:${recallLocationLabel(row, currentGuildId)}] [when:${recallTriggerLabel(row, resolveUserId)}] [${row.kind}]${row.priority > 0 ? " [IMPORTANT]" : ""}${age}${expiry}${source} ${row.content}`;
}

interface MemoryContextGroup {
  about: string;
  recallLocation: string;
  recallTrigger: string;
  rows: MemoryRow[];
}

/** Render selected actor memories with shared recall metadata grouped once. */
function formatMemoryContextRows(
  orderedRows: readonly MemoryRow[],
  currentGuildId: string,
  resolveUserId?: (userId: string) => string | undefined,
): string[] {
  const bands = [
    { label: "Normal", rows: orderedRows.filter((row) => row.priority <= 0) },
    { label: "Important", rows: orderedRows.filter((row) => row.priority > 0) },
  ].filter((band) => band.rows.length > 0);
  const lines: string[] = [];

  for (const band of bands) {
    if (lines.length > 0) lines.push("");
    lines.push(`## ${band.label}`);
    const groups = new Map<string, MemoryContextGroup>();
    for (const row of band.rows) {
      const about = aboutLabel(row, resolveUserId);
      const recallLocation = recallLocationLabel(row, currentGuildId);
      const recallTrigger = recallTriggerLabel(row, resolveUserId);
      const key = `${about}\u0000${recallLocation}\u0000${recallTrigger}`;
      const existing = groups.get(key);
      if (existing !== undefined) {
        existing.rows.push(row);
        continue;
      }
      groups.set(key, { about, recallLocation, recallTrigger, rows: [row] });
    }

    for (const group of groups.values()) {
      lines.push("", `### ${group.about} | ${group.recallLocation} | ${group.recallTrigger}`, "");
      const kindCounts = new Map<string, number>();
      for (const row of group.rows) kindCounts.set(row.kind, (kindCounts.get(row.kind) ?? 0) + 1);

      for (const row of group.rows.filter((candidate) => kindCounts.get(candidate.kind) === 1)) {
        const age = ` [${formatMemoryAge(row.updatedAt)}]`;
        const expiry = row.expiresAt !== null ? ` [${formatExpiry(row.expiresAt)}]` : "";
        lines.push(`${row.id} ${row.kind}${age}${expiry} | ${row.content}`);
      }

      const repeatedKinds = [...new Set(group.rows
        .filter((row) => (kindCounts.get(row.kind) ?? 0) > 1)
        .map((row) => row.kind))];
      for (const kind of repeatedKinds) {
        if (lines.at(-1) !== "") lines.push("");
        lines.push(`#### ${kind}`, "");
        for (const row of group.rows.filter((candidate) => candidate.kind === kind)) {
          const age = ` [${formatMemoryAge(row.updatedAt)}]`;
          const expiry = row.expiresAt !== null ? ` [${formatExpiry(row.expiresAt)}]` : "";
          lines.push(`${row.id}${age}${expiry} | ${row.content}`);
        }
      }
    }
  }

  return lines;
}

/** Build one rotating stored-memory slice for corpus maintenance. */
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
  const relevantUserIds = [...new Set([input.currentUserId, ...(input.visibleUserIds ?? [])])];
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
  const crossSubjectCapacity = Math.min(
    DEFAULT_CROSS_SUBJECT_RELEVANT_ROWS,
    Math.max(0, limit - recentRows.length - 1),
  );
  const visibleUserIds = input.visibleUserIds ?? [];
  const visibleUserIdSet = new Set([input.currentUserId, ...visibleUserIds]);
  const relationshipAnchorUserIds = [...new Set(input.relationshipAnchorUserIds ?? [])]
    .filter((userId) => !visibleUserIdSet.has(userId))
    .slice(0, DEFAULT_RELATIONSHIP_ANCHOR_MAX_USERS);
  const relationshipAnchorGroups = selectVisibleUserMemoryGroups({
    db: input.db,
    guildId: input.guildId,
    currentUserId: input.currentUserId,
    visibleUserIds: relationshipAnchorUserIds,
    maxUsers: DEFAULT_RELATIONSHIP_ANCHOR_MAX_USERS,
    maxMemoriesPerUser: DEFAULT_RELATIONSHIP_ANCHOR_MAX_MEMORIES,
    maxRows: Math.min(DEFAULT_RELATIONSHIP_ANCHOR_MAX_ROWS, crossSubjectCapacity),
  });
  const relationshipAnchorRows = relationshipAnchorGroups.flatMap((group) => group.rows);
  const relationshipAnchorTotal = relationshipAnchorGroups.reduce((total, group) => total + group.total, 0);
  const crossSubjectLimit = Math.max(0, crossSubjectCapacity - relationshipAnchorRows.length);
  const excludedCrossSubjects = [
    input.currentUserId,
    ...visibleUserIds,
    ...relationshipAnchorUserIds,
  ];
  const crossSubjectFilter = {
    guildId: input.guildId,
    about: "user" as const,
    relevantUserIds,
    excludeAboutUserIds: excludedCrossSubjects,
  };
  const unfilteredCrossSubjectTotal = countMemories(input.db, crossSubjectFilter);
  const crossSubjectCandidates = crossSubjectLimit > 0
    ? listMemories(input.db, {
        ...crossSubjectFilter,
        ...(input.resolveUserId === undefined ? { limit: crossSubjectLimit } : {}),
      })
    : [];
  const eligibleCrossSubjectRows = input.resolveUserId === undefined
    ? crossSubjectCandidates
    : crossSubjectCandidates.filter((row) => row.aboutUserId !== null
      && input.resolveUserId?.(row.aboutUserId) !== undefined);
  const crossSubjectRows = eligibleCrossSubjectRows.slice(0, crossSubjectLimit);
  const crossSubjectTotal = input.resolveUserId === undefined
    ? unfilteredCrossSubjectTotal
    : eligibleCrossSubjectRows.length;
  const primaryLimit = Math.max(0, limit - recentRows.length - crossSubjectRows.length);
  const maxSelfLimit = Math.min(primaryLimit, 30);
  const selfTotal = countMemories(input.db, {
    guildId: input.guildId,
    about: "self",
    relevantUserIds,
  });
  const selfRows = listMemories(input.db, {
    guildId: input.guildId,
    about: "self",
    relevantUserIds,
    limit: maxSelfLimit,
  }).filter((row) => row.content.trim() !== "");
  const conversationalLimit = Math.max(0, primaryLimit - selfRows.length);
  const conversationalTotal = countMemories(input.db, {
    guildId: input.guildId,
    aboutUserId: input.currentUserId,
    includeCommunity: true,
    relevantUserIds,
  });
  const conversationalRows = conversationalLimit > 0
    ? listMemories(input.db, {
        guildId: input.guildId,
        aboutUserId: input.currentUserId,
        includeCommunity: true,
        relevantUserIds,
        limit: conversationalLimit,
      }).filter((row) => row.content.trim() !== "")
    : [];
  const total = conversationalTotal + selfTotal + recentTotal + relationshipAnchorTotal + crossSubjectTotal;
  const rows = [...conversationalRows, ...selfRows, ...relationshipAnchorRows, ...crossSubjectRows]
    .sort((a, b) => {
      const priorityDiff = a.priority - b.priority;
      if (priorityDiff !== 0) return priorityDiff;
      const updatedDiff = a.updatedAt - b.updatedAt;
      return updatedDiff !== 0 ? updatedDiff : a.id - b.id;
    });

  if (rows.length === 0 && recentRows.length === 0) return "";

  const orderedRecentRows = [...recentGroups].reverse().flatMap((group) => [...group.rows].reverse());
  const orderedRows = [...rows, ...orderedRecentRows];
  const lines = formatMemoryContextRows(orderedRows, input.guildId, input.resolveUserId);
  const shown = orderedRows.length;
  const showingLine = shown < total ? `${shown}/${total} shown.` : "";
  const contextInstruction = input.contextInstruction?.trim() ?? "";
  const prefix = [
    showingLine,
    contextInstruction,
  ].filter((line) => line !== "");
  return [
    ...prefix,
    ...(prefix.length > 0 ? [""] : []),
    ...lines,
  ].join("\n");
}

/** Build a broad private-life memory slice without using recent chat speakers. */
export function buildPrivateLifeMemoryContext(input: PrivateLifeMemoryContextInput): string {
  const limit = Math.max(1, input.limit ?? 80);
  const notableUserIds = [...new Set(input.notableUserIds)].slice(0, 3);
  const recentRows = listMemories(input.db, {
    guildId: input.guildId,
    about: "any",
    relevantUserIds: notableUserIds,
    order: "recent",
    limit: Math.min(16, limit),
  });
  const selected = new Map<number, MemoryRow>(recentRows.map((row) => [row.id, row]));

  for (const userId of notableUserIds) {
    if (selected.size >= limit) break;
    const rows = listMemories(input.db, {
      guildId: input.guildId,
      aboutUserId: userId,
      relevantUserIds: notableUserIds,
      limit: Math.min(6, limit - selected.size),
    });
    for (const row of rows) selected.set(row.id, row);
  }

  if (selected.size < limit) {
    const selfRows = listMemories(input.db, {
      guildId: input.guildId,
      about: "self",
      relevantUserIds: notableUserIds,
      limit: limit - selected.size,
    });
    for (const row of selfRows) selected.set(row.id, row);
  }

  const rows = [...selected.values()]
    .sort((a, b) => {
      const updatedDifference = a.updatedAt - b.updatedAt;
      return updatedDifference !== 0 ? updatedDifference : a.id - b.id;
    })
    .slice(0, limit);
  if (rows.length === 0) return "";
  const contextInstruction = input.contextInstruction?.trim() ?? "";
  return [
    contextInstruction,
    ...(contextInstruction !== "" ? [""] : []),
    ...formatMemoryContextRows(rows, input.guildId, input.resolveUserId),
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
    const availableRows = listMemories(input.db, {
      guildId: input.guildId,
      aboutUserId: userId,
      relevantUserIds: [input.currentUserId, ...input.visibleUserIds],
    });
    const rows = selectReservedUserMemoryRows(availableRows, rowLimit);
    if (rows.length === 0) continue;

    groups.push({
      userId,
      rows,
      total: countMemories(input.db, {
        guildId: input.guildId,
        aboutUserId: userId,
        relevantUserIds: [input.currentUserId, ...input.visibleUserIds],
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
    "",
  ];
  const orderedRows = [...groups].reverse().flatMap((group) => [...group.rows].reverse());
  lines.push(...formatMemoryContextRows(orderedRows, input.guildId, input.resolveUserId));
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

function normalizeRecallWhen(
  value: unknown,
  about: MemoryAbout,
  username: string | undefined,
): MemoryRecallWhenInput | undefined {
  if (value === "always") return "always";
  if (isRecord(value)) {
    const usernames = normalizeUsernameList(value.users_present);
    if (usernames !== undefined && usernames.length > 0) return { users_present: usernames };
  }
  if (value !== undefined) return undefined;
  return about === "user" && username !== undefined ? { users_present: [username] } : "always";
}

function normalizeAbout(value: unknown): MemoryAbout | null {
  return value === "community" || value === "self" || value === "user" ? value : null;
}

function normalizeRecallIn(value: unknown, about: MemoryAbout): MemoryRecallInInput | undefined {
  if (value === "anywhere" || value === "current_guild") return value;
  if (value !== undefined) return undefined;
  return about === "community" ? "current_guild" : "anywhere";
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

function memoryKindAboutIsValid(kind: MemoryKind, about: MemoryAbout): boolean {
  return kind !== "journal" || about === "self";
}

function normalizeExtractionAction(value: unknown): MemoryExtraction["actions"][number] | null {
  if (!isRecord(value)) return null;
  const rawAction = value.action;
  if (rawAction === "none") return { action: "none" };

  if (rawAction === "delete") {
    const id = value.id;
    return typeof id === "number" && Number.isInteger(id) && id > 0 ? { action: "delete", id } : null;
  }

  if (rawAction === "create" || rawAction === "update") {
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
    const about = normalizeAbout(value.about);
    if (about === null) return null;
    const username = normalizeUsername(value.username);
    const recallIn = normalizeRecallIn(value.recall_in, about);
    const recallWhen = normalizeRecallWhen(value.recall_when, about, username);
    if (recallIn === undefined || recallWhen === undefined) return null;
    const action = rawAction;
    if (action === "update" && id === undefined) return null;
    const normalized = {
      about,
      ...(username !== undefined ? { username } : {}),
      recall_in: recallIn,
      recall_when: recallWhen,
      kind,
      content,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(typeof value.important === "boolean" ? { important: value.important } : {}),
      ...(expiresIn !== undefined ? { expiresIn } : {}),
    };
    return action === "update" && id !== undefined
      ? { action, id, ...normalized }
      : { action: "create", ...normalized };
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
                  required: ["action", "about", "kind", "content"],
                  properties: {
                    action: { const: "create" },
                    about: { type: "string", enum: ["community", "user", "self"] },
                    username: { type: "string", minLength: 1 },
                    recall_in: { type: "string", enum: ["anywhere", "current_guild"] },
                    recall_when: {
                      anyOf: [
                        { const: "always" },
                        {
                          type: "object",
                          additionalProperties: false,
                          required: ["users_present"],
                          properties: {
                            users_present: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
                          },
                        },
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
                  required: ["action", "id", "about", "recall_in", "recall_when", "kind", "content"],
                  properties: {
                    action: { const: "update" },
                    id: { type: "integer", minimum: 1 },
                    about: { type: "string", enum: ["community", "user", "self"] },
                    username: { type: "string", minLength: 1 },
                    recall_in: { type: "string", enum: ["anywhere", "current_guild"] },
                    recall_when: {
                      anyOf: [
                        { const: "always" },
                        {
                          type: "object",
                          additionalProperties: false,
                          required: ["users_present"],
                          properties: {
                            users_present: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
                          },
                        },
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
  if (existing.recallIn !== "anywhere" && existing.recallIn.guildId !== input.guildId) return null;
  return existing;
}

interface MemoryActionTarget {
  about: MemoryAbout;
  aboutUserId: string | null;
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

async function resolveRecallWhen(
  input: MemoryMutationInput,
  recallWhen: MemoryRecallWhenInput,
): Promise<"always" | string[]> {
  if (recallWhen === "always") return "always";
  const userIds: string[] = [];
  for (const username of recallWhen.users_present) userIds.push(await resolveUserReference(input, username));
  return [...new Set(userIds)];
}

async function actionMemoryTarget(
  input: MemoryMutationInput,
  action: MemoryWriteAction,
): Promise<MemoryActionTarget> {
  if (action.about === "self") return { about: "self", aboutUserId: null };
  if (action.about === "community") return { about: "community", aboutUserId: null };

  const username = normalizeUsername(action.username);
  if (username === undefined) throw new Error("User memories require username.");
  return { about: "user", aboutUserId: await resolveUserReference(input, username) };
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

    const existing = action.action === "update" ? editableMemory(input, action.id) : null;
    if (action.action === "update" && existing === null) {
      throw new Error(`Memory ${action.id} is not editable from this guild.`);
    }
    if (action.action === "update") {
      if (mutatedIds.has(action.id)) throw new Error(`Memory ${action.id} has multiple mutations in one batch.`);
      mutatedIds.add(action.id);
    }

    const target = await actionMemoryTarget(input, action);
    const recallIn = action.recall_in ?? (target.about === "community" ? "current_guild" : "anywhere");
    const recallWhen = action.recall_when === undefined
      ? target.about === "user" && target.aboutUserId !== null ? [target.aboutUserId] : "always"
      : await resolveRecallWhen(input, action.recall_when);
    if (!memoryKindAboutIsValid(action.kind, target.about)) throw new Error("Journal memories must be about self.");
    if (target.about === "community" && recallIn !== "current_guild") {
      throw new Error("Community memories must be recalled in the current guild.");
    }
    if (!scratchpadExpiryIsValid(action, existing)) throw new Error("Scratchpad memories require expiresIn of at most seven days.");
    const expiresAt = action.expiresIn === undefined
      ? undefined
      : action.expiresIn === null
        ? null
        : expiresInToExpiresAt(action.expiresIn);
    const common = {
      about: target.about,
      aboutUserId: target.aboutUserId,
      recallIn: recallIn === "anywhere" ? "anywhere" as const : { guildId: input.guildId },
      recallWhen,
      kind: action.kind,
      content: action.content.trim(),
      ...(action.source_message_id !== undefined ? { sourceMessageId: action.source_message_id } : {}),
      confidence: action.confidence,
      ...(action.important !== undefined ? { priority: action.important ? 1 : 0 } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    if (common.content === "") throw new Error("Memory content cannot be empty.");

    if (action.action === "update") {
      prepared.push({ action: "update", id: action.id, input: common });
    } else {
      prepared.push({
        action: "create",
        input: {
          guildId: input.guildId,
          ...common,
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
