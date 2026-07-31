import type { Database } from "../db/database.ts";
import {
  countMemories,
  listMemoryMaintenanceBatch,
  listMemories,
  type MemoryRow,
} from "../db/memory-repository.ts";

const DEFAULT_RECENT_USER_MAX_USERS = 3;
const DEFAULT_RECENT_USER_MAX_MEMORIES = 4;
const DEFAULT_RECENT_USER_MAX_ROWS = 12;
const DEFAULT_CROSS_SUBJECT_RELEVANT_ROWS = 10;
const DEFAULT_RELATIONSHIP_ANCHOR_MAX_USERS = 2;
const DEFAULT_RELATIONSHIP_ANCHOR_MAX_MEMORIES = 2;
const DEFAULT_RELATIONSHIP_ANCHOR_MAX_ROWS = 4;

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

function formatImportanceEnd(importantUntil: number): string {
  return formatExpiry(importantUntil).replace("expires in", "important for");
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

export function formatMemoryAge(updatedAt: number, now = Date.now()): string {
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
  const importanceEnd = row.priority > 0 && row.importantUntil !== null ? ` [${formatImportanceEnd(row.importantUntil)}]` : "";
  return `- ${row.id} [about:${aboutLabel(row, resolveUserId)}] [in:${recallLocationLabel(row, currentGuildId)}] [when:${recallTriggerLabel(row, resolveUserId)}] [${formatConfidence(row.confidence)}] [${row.kind}]${row.priority > 0 ? " [IMPORTANT]" : ""}${age}${expiry}${importanceEnd} ${row.content}`;
}

/** Render one self-contained memory search result without internal confidence. */
export function formatMemorySearchRow(
  row: MemoryRow,
  currentGuildId: string,
  resolveUserId?: (userId: string) => string | undefined,
): string {
  const age = ` [${formatMemoryAge(row.updatedAt)}]`;
  const expiry = row.expiresAt !== null ? ` [${formatExpiry(row.expiresAt)}]` : "";
  const importanceEnd = row.priority > 0 && row.importantUntil !== null ? ` [${formatImportanceEnd(row.importantUntil)}]` : "";
  const source = row.sourceMessageId === null ? "" : ` [${row.sourceMessageId}]`;
  return `- ${row.id} [about:${aboutLabel(row, resolveUserId)}] [in:${recallLocationLabel(row, currentGuildId)}] [when:${recallTriggerLabel(row, resolveUserId)}] [${row.kind}]${row.priority > 0 ? " [IMPORTANT]" : ""}${age}${expiry}${importanceEnd}${source} ${row.content}`;
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
        const importanceEnd = row.priority > 0 && row.importantUntil !== null ? ` [${formatImportanceEnd(row.importantUntil)}]` : "";
        lines.push(`${row.id} ${row.kind}${age}${expiry}${importanceEnd} | ${row.content}`);
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
          const importanceEnd = row.priority > 0 && row.importantUntil !== null ? ` [${formatImportanceEnd(row.importantUntil)}]` : "";
          lines.push(`${row.id}${age}${expiry}${importanceEnd} | ${row.content}`);
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

/** Shared policy for memory-writing prompts and the record_memory tool. */
export function buildMemoryPolicyInstructions(): string[] {
  return [
    "Preserve only durable, future-useful memory and choose the cleanest focused row structure rather than minimizing mutations.",
    "Set important true only for memories that must reliably shape behavior while active. Importance and expiry are independent; importantUntil lowers priority without deleting the memory.",
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
