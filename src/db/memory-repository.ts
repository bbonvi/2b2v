import type { Database } from "./database";

export type MemoryScope = "user" | "journal";

const DEFAULT_TTL_DAYS = 180; // 6 months
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface MemoryRow {
  id: number;
  scope: MemoryScope;
  guildId: string | null;
  userId: string | null;
  title: string;
  content: string | null;
  sourceMessageId: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export interface CreateMemoryInput {
  scope: MemoryScope;
  guildId: string;
  userId: string;
  title: string;
  content?: string;
  sourceMessageId?: string;
  /** Days until expiry. Default 180. Pass null to disable. */
  ttlDays?: number | null;
}

export interface UpdateMemoryInput {
  title?: string;
  content?: string;
  /** Recompute expiry from now + ttlDays. Pass null to remove expiry. */
  ttlDays?: number | null;
}

export interface ListMemoriesFilter {
  scope: MemoryScope;
  guildId: string;
  userId?: string;
  limit?: number;
}

function computeExpiry(_scope: MemoryScope, ttlDays?: number | null): number | null {
  if (ttlDays === null) return null;
  if (ttlDays !== undefined) return Date.now() + ttlDays * MS_PER_DAY;
  return Date.now() + DEFAULT_TTL_DAYS * MS_PER_DAY;
}

/** Create a memory entry. Returns the generated ID. */
export function createMemory(db: Database, input: CreateMemoryInput): number {
  const now = Date.now();
  const expiresAt = computeExpiry(input.scope, input.ttlDays);

  const result = db.raw
    .prepare(
      `INSERT INTO memories (scope, guild_id, user_id, short_description, long_description, source_message_id, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.scope,
      input.guildId,
      input.userId,
      input.title,
      input.content ?? null,
      input.sourceMessageId ?? null,
      now,
      now,
      expiresAt
    );

  return Number(result.lastInsertRowid);
}

/** Update fields on an existing memory. Returns true if the row existed. */
export function updateMemory(db: Database, id: number, input: UpdateMemoryInput): boolean {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if (input.title !== undefined) {
    sets.push("short_description = ?");
    params.push(input.title);
  }
  if (input.content !== undefined) {
    sets.push("long_description = ?");
    params.push(input.content);
  }
  if ("ttlDays" in input) {
    sets.push("expires_at = ?");
    params.push(input.ttlDays === null ? null : Date.now() + (input.ttlDays ?? DEFAULT_TTL_DAYS) * MS_PER_DAY);
  }

  sets.push("updated_at = ?");
  params.push(Date.now());
  params.push(id);

  const result = db.raw.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return result.changes > 0;
}

/** Delete a memory by ID. Returns true if the row existed. */
export function deleteMemory(db: Database, id: number): boolean {
  const result = db.raw.prepare("DELETE FROM memories WHERE id = ?").run(id);
  return result.changes > 0;
}

/** Get a single memory by ID. Returns null if not found. */
export function getMemory(db: Database, id: number): MemoryRow | null {
  const row = db.raw.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Record<string, unknown> | null;
  if (!row) return null;
  return mapRow(row);
}

/** List memories matching the filter. Excludes expired entries. */
export function listMemories(db: Database, filter: ListMemoriesFilter): MemoryRow[] {
  const conditions = ["scope = ?"];
  const params: (string | number | null)[] = [filter.scope];

  conditions.push("guild_id = ?");
  params.push(filter.guildId);

  if (filter.userId !== undefined) {
    conditions.push("user_id = ?");
    params.push(filter.userId);
  }

  // Exclude expired
  conditions.push("(expires_at IS NULL OR expires_at > ?)");
  params.push(Date.now());

  let sql = `SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`;
  if (filter.limit !== undefined && filter.limit > 0) {
    sql += ` LIMIT ?`;
    params.push(filter.limit);
  }

  const rows = db.raw.prepare(sql).all(...params) as Record<string, unknown>[];

  // Reverse to chronological order (oldest first)
  rows.reverse();

  return rows.map(mapRow);
}

/** Delete all expired memories. Returns count deleted. */
export function deleteExpiredMemories(db: Database): number {
  const result = db.raw
    .prepare("DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?")
    .run(Date.now());
  return result.changes;
}

/** Count user memories per userId in a guild. Returns Map<userId, count>. */
export function countUserMemoriesByUser(db: Database, guildId: string): Map<string, number> {
  const rows = db.raw
    .prepare(
      `SELECT user_id, COUNT(*) as count FROM memories
       WHERE scope = 'user' AND guild_id = ?
       AND (expires_at IS NULL OR expires_at > ?)
       GROUP BY user_id`
    )
    .all(guildId, Date.now()) as Array<{ user_id: string; count: number }>;

  const result = new Map<string, number>();
  for (const row of rows) {
    result.set(row.user_id, row.count);
  }
  return result;
}

function mapRow(row: Record<string, unknown>): MemoryRow {
  return {
    id: Number(row.id),
    scope: row.scope as MemoryScope,
    guildId: row.guild_id as string | null,
    userId: row.user_id as string | null,
    title: row.short_description as string,
    content: row.long_description as string | null,
    sourceMessageId: row.source_message_id as string | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    expiresAt: row.expires_at as number | null,
  };
}
