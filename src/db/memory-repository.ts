import type { Database } from "./database";
import { sanitizeMemoryContent } from "./memory-content";
import type { MemoryKind } from "./memory-kinds";
export { MEMORY_KINDS, isMemoryKind, type MemoryKind } from "./memory-kinds";

export type MemoryAbout = "community" | "user" | "self";
export type MemoryRecallIn = "anywhere" | { guildId: string };
export type MemoryRecallWhen = "always" | readonly string[];

export interface MemoryRow {
  id: number;
  about: MemoryAbout;
  aboutUserId: string | null;
  recallIn: "anywhere" | { guildId: string };
  recallWhen: "always" | string[];
  kind: MemoryKind;
  content: string;
  sourceMessageId: string | null;
  provenance: Record<string, unknown> | null;
  confidence: number;
  priority: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  deletedAt: number | null;
}

export interface CreateMemoryInput {
  guildId: string;
  about?: MemoryAbout;
  aboutUserId?: string | null;
  recallIn?: MemoryRecallIn;
  recallWhen?: MemoryRecallWhen;
  kind: MemoryKind;
  content: string;
  sourceMessageId?: string | null;
  provenance?: Record<string, unknown> | null;
  confidence?: number;
  priority?: number;
  expiresAt?: number | null;
}

export interface UpdateMemoryInput {
  about?: MemoryAbout;
  aboutUserId?: string | null;
  recallIn?: MemoryRecallIn;
  recallWhen?: MemoryRecallWhen;
  kind?: MemoryKind;
  content?: string;
  sourceMessageId?: string | null;
  provenance?: Record<string, unknown> | null;
  confidence?: number;
  priority?: number;
  expiresAt?: number | null;
  deletedAt?: number | null;
}

export interface ListMemoriesFilter {
  guildId: string;
  about?: MemoryAbout | "any";
  aboutUserId?: string | null;
  includeCommunity?: boolean;
  includeSelf?: boolean;
  includeDeleted?: boolean;
  /** Keep always-recalled rows plus rows triggered by at least one visible user. */
  relevantUserIds?: readonly string[];
  excludeAboutUserIds?: readonly string[];
  order?: "priority" | "recent";
  limit?: number;
}

export type CountMemoriesFilter = Omit<ListMemoriesFilter, "limit" | "order">;

export interface MemoryMaintenanceBatch {
  rows: MemoryRow[];
  nextCursorId: number;
}

function clampConfidence(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0.7;
  return Math.max(0, Math.min(1, value));
}

function clampPriority(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizeUserIds(userIds: readonly string[] | undefined): string[] {
  if (userIds === undefined) return [];
  return [...new Set(userIds.map((userId) => userId.trim()).filter((userId) => userId !== ""))];
}

function effectiveRecallWhen(
  about: MemoryAbout,
  aboutUserId: string | null,
  recallWhen: MemoryRecallWhen | undefined,
): "always" | string[] {
  if (recallWhen === "always") return "always";
  if (recallWhen !== undefined) {
    const normalized = normalizeUserIds(recallWhen);
    if (normalized.length === 0) throw new Error("User-triggered recall requires at least one user ID.");
    return normalized;
  }
  return about === "user" && aboutUserId !== null ? [aboutUserId] : "always";
}

function replaceMemoryRecallUsers(db: Database, memoryId: number, recallWhen: "always" | readonly string[]): void {
  db.raw.prepare("DELETE FROM memory_recall_users WHERE memory_id = ?").run(memoryId);
  if (recallWhen === "always") return;
  const insert = db.raw.prepare("INSERT INTO memory_recall_users (memory_id, user_id) VALUES (?, ?)");
  for (const userId of recallWhen) insert.run(memoryId, userId);
}

/** Return recall-trigger user IDs keyed by memory ID. */
export function listMemoryRecallUsers(
  db: Database,
  memoryIds: readonly number[],
): Map<number, string[]> {
  const uniqueIds = [...new Set(memoryIds)];
  const result = new Map<number, string[]>();
  for (const id of uniqueIds) result.set(id, []);
  const chunkSize = 400;
  for (let offset = 0; offset < uniqueIds.length; offset += chunkSize) {
    const chunk = uniqueIds.slice(offset, offset + chunkSize);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db.raw
      .prepare(`SELECT memory_id, user_id FROM memory_recall_users WHERE memory_id IN (${placeholders}) ORDER BY memory_id, user_id`)
      .all(...chunk) as Array<{ memory_id: number; user_id: string }>;
    for (const row of rows) result.get(row.memory_id)?.push(row.user_id);
  }
  return result;
}

function resolvedAboutFields(input: Pick<CreateMemoryInput, "about" | "aboutUserId">): {
  about: MemoryAbout;
  aboutUserId: string | null;
} {
  const about = input.about ?? (input.aboutUserId !== undefined && input.aboutUserId !== null ? "user" : "community");
  if (about === "user") {
    if (input.aboutUserId === undefined || input.aboutUserId === null || input.aboutUserId.trim() === "") {
      throw new Error("User memories require aboutUserId.");
    }
    return { about, aboutUserId: input.aboutUserId.trim() };
  }
  return { about, aboutUserId: null };
}

function resolvedRecallIn(about: MemoryAbout, guildId: string, recallIn: MemoryRecallIn | undefined): MemoryRecallIn {
  const resolved = recallIn ?? (about === "community" ? { guildId } : "anywhere");
  if (resolved !== "anywhere" && resolved.guildId.trim() === "") throw new Error("Guild recall requires a guild ID.");
  if (about === "community" && resolved === "anywhere") {
    throw new Error("Community memories must be recalled in one guild.");
  }
  return resolved === "anywhere" ? resolved : { guildId: resolved.guildId.trim() };
}

function assertKindAbout(kind: MemoryKind, about: MemoryAbout): void {
  if (kind === "journal" && about !== "self") {
    throw new Error("Journal memories must be about self.");
  }
}

function memoryFilterConditions(filter: CountMemoriesFilter): {
  conditions: string[];
  params: (string | number | null)[];
} {
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  conditions.push("(recall_scope = 'anywhere' OR recall_guild_id = ?)");
  params.push(filter.guildId);

  if (filter.about === "any") {
    // No subject restriction.
  } else if (filter.about === "self") {
    conditions.push("about_type = 'self'");
  } else if (filter.about === "community") {
    conditions.push("about_type = 'community'");
  } else if (filter.about === "user") {
    conditions.push("about_type = 'user'");
    if (filter.aboutUserId !== undefined && filter.aboutUserId !== null) {
      conditions.push("about_user_id = ?");
      params.push(filter.aboutUserId);
    }
  } else if (filter.aboutUserId !== undefined) {
    if (filter.includeCommunity === true) {
      const clauses = ["(about_type = 'user' AND about_user_id = ?)", "about_type = 'community'"];
      params.push(filter.aboutUserId);
      if (filter.includeSelf === true) clauses.push("about_type = 'self'");
      conditions.push(`(${clauses.join(" OR ")})`);
    } else if (filter.aboutUserId === null) {
      conditions.push("about_type = 'community'");
    } else {
      conditions.push("about_type = 'user'");
      conditions.push("about_user_id = ?");
      params.push(filter.aboutUserId);
    }
  } else {
    conditions.push("about_type = 'community'");
  }

  if (filter.excludeAboutUserIds !== undefined) {
    const excluded = normalizeUserIds(filter.excludeAboutUserIds);
    if (excluded.length > 0) {
      conditions.push(`(about_user_id IS NULL OR about_user_id NOT IN (${excluded.map(() => "?").join(",")}))`);
      params.push(...excluded);
    }
  }

  if (filter.relevantUserIds !== undefined) {
    const userIds = normalizeUserIds(filter.relevantUserIds);
    const triggeredClause = userIds.length === 0
      ? ""
      : ` OR EXISTS (
          SELECT 1 FROM memory_recall_users recall_user
          WHERE recall_user.memory_id = memories.id
            AND recall_user.user_id IN (${userIds.map(() => "?").join(",")})
        )`;
    conditions.push(`(recall_mode = 'always'${triggeredClause})`);
    params.push(...userIds);
  }

  if (filter.includeDeleted !== true) {
    conditions.push("deleted_at IS NULL");
    conditions.push("(expires_at IS NULL OR expires_at > ?)");
    params.push(Date.now());
  }

  return { conditions, params };
}

/** Create a structured memory row and return its generated ID. */
export function createMemory(db: Database, input: CreateMemoryInput): number {
  const now = Date.now();
  const { about, aboutUserId } = resolvedAboutFields(input);
  const recallIn = resolvedRecallIn(about, input.guildId, input.recallIn);
  const recallWhen = effectiveRecallWhen(about, aboutUserId, input.recallWhen);
  assertKindAbout(input.kind, about);
  const content = sanitizeMemoryContent(input.content);
  if (content === "") {
    throw new Error("Memory content cannot be empty.");
  }
  const result = db.raw
    .prepare(
      `INSERT INTO memories (about_type, about_user_id, recall_scope, recall_guild_id, recall_mode, kind, content, source_message_id, provenance_json, confidence, priority, created_at, updated_at, expires_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      about,
      aboutUserId,
      recallIn === "anywhere" ? "anywhere" : "guild",
      recallIn === "anywhere" ? null : recallIn.guildId,
      recallWhen === "always" ? "always" : "users",
      input.kind,
      content,
      input.sourceMessageId ?? null,
      input.provenance !== undefined && input.provenance !== null ? JSON.stringify(input.provenance) : null,
      clampConfidence(input.confidence),
      clampPriority(input.priority),
      now,
      now,
      input.expiresAt ?? null,
    );

  const id = Number(result.lastInsertRowid);
  replaceMemoryRecallUsers(db, id, recallWhen);
  return id;
}

/** Update fields on an existing memory. Returns true if the row existed. */
export function updateMemory(db: Database, id: number, input: UpdateMemoryInput): boolean {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  const existing = db.raw
    .prepare("SELECT about_type, about_user_id, recall_scope, recall_guild_id, recall_mode, kind FROM memories WHERE id = ?")
    .get(id) as {
      about_type: MemoryAbout;
      about_user_id: string | null;
      recall_scope: "anywhere" | "guild";
      recall_guild_id: string | null;
      recall_mode: "always" | "users";
      kind: MemoryKind;
  } | null;
  if (existing === null) return false;
  if (input.about === undefined && "aboutUserId" in input && existing.about_type !== "user") {
    throw new Error("Changing the about-user requires about=user.");
  }
  const effectiveAbout = input.about ?? existing.about_type;
  const aboutFields = input.about !== undefined || "aboutUserId" in input
    ? resolvedAboutFields({ about: effectiveAbout, aboutUserId: input.aboutUserId ?? existing.about_user_id })
    : { about: existing.about_type, aboutUserId: existing.about_user_id };
  const effectiveKind = input.kind ?? existing.kind;
  const currentRecallIn: MemoryRecallIn = existing.recall_scope === "anywhere"
    ? "anywhere"
    : { guildId: existing.recall_guild_id ?? "" };
  const recallIn = input.recallIn !== undefined
    ? resolvedRecallIn(aboutFields.about, existing.recall_guild_id ?? "", input.recallIn)
    : currentRecallIn;
  if (aboutFields.about === "community" && recallIn === "anywhere") {
    throw new Error("Community memories must be recalled in one guild.");
  }
  const resolvedRecallWhen = input.recallWhen !== undefined
    ? effectiveRecallWhen(aboutFields.about, aboutFields.aboutUserId, input.recallWhen)
    : undefined;
  assertKindAbout(effectiveKind, aboutFields.about);

  if (input.about !== undefined || "aboutUserId" in input) {
    sets.push("about_type = ?", "about_user_id = ?");
    params.push(aboutFields.about, aboutFields.aboutUserId);
  }
  if (input.recallIn !== undefined) {
    sets.push("recall_scope = ?", "recall_guild_id = ?");
    params.push(recallIn === "anywhere" ? "anywhere" : "guild", recallIn === "anywhere" ? null : recallIn.guildId);
  }
  if (input.kind !== undefined) {
    sets.push("kind = ?");
    params.push(input.kind);
  }
  if (input.content !== undefined) {
    const content = sanitizeMemoryContent(input.content);
    if (content === "") return false;
    sets.push("content = ?");
    params.push(content);
  }
  if ("sourceMessageId" in input) {
    sets.push("source_message_id = ?");
    params.push(input.sourceMessageId ?? null);
  }
  if ("provenance" in input) {
    sets.push("provenance_json = ?");
    params.push(input.provenance !== undefined && input.provenance !== null ? JSON.stringify(input.provenance) : null);
  }
  if (input.confidence !== undefined) {
    sets.push("confidence = ?");
    params.push(clampConfidence(input.confidence));
  }
  if (input.priority !== undefined) {
    sets.push("priority = ?");
    params.push(clampPriority(input.priority));
  }
  if (input.recallWhen !== undefined) {
    sets.push("recall_mode = ?");
    params.push(resolvedRecallWhen === "always" ? "always" : "users");
  }
  if ("expiresAt" in input) {
    sets.push("expires_at = ?");
    params.push(input.expiresAt ?? null);
  }
  if ("deletedAt" in input) {
    sets.push("deleted_at = ?");
    params.push(input.deletedAt ?? null);
  }

  sets.push("updated_at = ?");
  params.push(Date.now());
  params.push(id);

  const result = db.raw.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  if (result.changes > 0 && resolvedRecallWhen !== undefined) {
    replaceMemoryRecallUsers(db, id, resolvedRecallWhen);
  }
  return result.changes > 0;
}

/** Soft-delete a memory by ID. Returns true if the row existed. */
export function deleteMemory(db: Database, id: number): boolean {
  return updateMemory(db, id, { deletedAt: Date.now() });
}

/** Hard-delete soft-deleted or expired memories. Returns count removed. */
export function deleteExpiredMemories(db: Database): number {
  const result = db.raw
    .prepare("DELETE FROM memories WHERE deleted_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= ?)")
    .run(Date.now());
  return result.changes;
}

/** Get a single active memory by ID. Returns null if not found, deleted, or expired. */
export function getMemory(db: Database, id: number): MemoryRow | null {
  const row = db.raw
    .prepare("SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)")
    .get(id, Date.now()) as Record<string, unknown> | null;
  if (row === null) return null;
  return mapRow(row, listMemoryRecallUsers(db, [id]).get(id) ?? []);
}

/** List active memories by subject, recall location, and optional user-presence trigger. */
export function listMemories(db: Database, filter: ListMemoriesFilter): MemoryRow[] {
  const { conditions, params } = memoryFilterConditions(filter);

  const order = filter.order === "recent"
    ? "created_at DESC, id DESC"
    : "priority DESC, updated_at DESC, id DESC";
  let sql = `SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY ${order}`;
  if (filter.limit !== undefined && filter.limit > 0) {
    sql += " LIMIT ?";
    params.push(filter.limit);
  }

  const rows = db.raw.prepare(sql).all(...params) as Record<string, unknown>[];
  const recallUsers = listMemoryRecallUsers(db, rows.map((row) => Number(row.id)));
  return rows.map((row) => mapRow(row, recallUsers.get(Number(row.id)) ?? []));
}

/** Count memories matching the same filters as listMemories. */
export function countMemories(db: Database, filter: CountMemoriesFilter): number {
  const { conditions, params } = memoryFilterConditions(filter);
  const row = db.raw
    .prepare(`SELECT COUNT(*) AS count FROM memories WHERE ${conditions.join(" AND ")}`)
    .get(...params) as { count: number };
  return row.count;
}

/** Count active user memories available from the current guild, grouped by subject. */
export function countUserMemoriesByUser(db: Database, guildId: string): Map<string, number> {
  const rows = db.raw
    .prepare(
      `SELECT about_user_id, COUNT(*) as count FROM memories
       WHERE about_type = 'user' AND about_user_id IS NOT NULL
         AND (recall_scope = 'anywhere' OR recall_guild_id = ?)
         AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       GROUP BY about_user_id`
    )
    .all(guildId, Date.now()) as Array<{ about_user_id: string; count: number }>;

  const result = new Map<string, number>();
  for (const row of rows) {
    result.set(row.about_user_id, row.count);
  }
  return result;
}

/** Return a bounded, rotating slice of memories maintainable from one guild. */
export function listMemoryMaintenanceBatch(
  db: Database,
  input: { guildId: string; afterId: number; limit: number },
): MemoryMaintenanceBatch {
  const limit = Math.max(1, Math.trunc(input.limit));
  const select = (afterId: number): Record<string, unknown>[] => db.raw
    .prepare(
      `SELECT * FROM memories
       WHERE id > ?
         AND deleted_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)
         AND (recall_scope = 'anywhere' OR recall_guild_id = ?)
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(afterId, Date.now(), input.guildId, limit) as Record<string, unknown>[];

  let rows = select(Math.max(0, Math.trunc(input.afterId)));
  if (rows.length === 0 && input.afterId > 0) rows = select(0);
  const recallUsers = listMemoryRecallUsers(db, rows.map((row) => Number(row.id)));
  const mapped = rows.map((row) => mapRow(row, recallUsers.get(Number(row.id)) ?? []));
  return {
    rows: mapped,
    nextCursorId: mapped.at(-1)?.id ?? Math.max(0, Math.trunc(input.afterId)),
  };
}

function mapRow(row: Record<string, unknown>, recallUserIds: string[]): MemoryRow {
  const provenanceRaw = row.provenance_json;
  let provenance: Record<string, unknown> | null = null;
  if (typeof provenanceRaw === "string" && provenanceRaw.trim() !== "") {
    const parsed: unknown = JSON.parse(provenanceRaw);
    provenance = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  }
  return {
    id: Number(row.id),
    about: row.about_type as MemoryAbout,
    aboutUserId: row.about_user_id as string | null,
    recallIn: row.recall_scope === "anywhere" ? "anywhere" : { guildId: row.recall_guild_id as string },
    recallWhen: row.recall_mode === "always" ? "always" : recallUserIds,
    kind: row.kind as MemoryKind,
    content: sanitizeMemoryContent(row.content as string),
    sourceMessageId: row.source_message_id as string | null,
    provenance,
    confidence: Number(row.confidence),
    priority: Number(row.priority ?? 0),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    expiresAt: row.expires_at as number | null,
    deletedAt: row.deleted_at as number | null,
  };
}
