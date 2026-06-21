import type { Database } from "./database";

export type MemoryKind =
  | "global_note"
  | "user_note"
  | "preference"
  | "relationship"
  | "project"
  | "fact";

export interface MemoryRow {
  id: number;
  guildId: string;
  subjectUserId: string | null;
  kind: MemoryKind;
  content: string;
  sourceMessageId: string | null;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  deletedAt: number | null;
}

export interface CreateMemoryInput {
  guildId: string;
  subjectUserId?: string | null;
  kind: MemoryKind;
  content: string;
  sourceMessageId?: string | null;
  confidence?: number;
  expiresAt?: number | null;
}

export interface UpdateMemoryInput {
  subjectUserId?: string | null;
  kind?: MemoryKind;
  content?: string;
  sourceMessageId?: string | null;
  confidence?: number;
  expiresAt?: number | null;
  deletedAt?: number | null;
}

export interface ListMemoriesFilter {
  guildId: string;
  subjectUserId?: string | null;
  includeGlobal?: boolean;
  includeDeleted?: boolean;
  limit?: number;
}

export type CountMemoriesFilter = Omit<ListMemoriesFilter, "limit">;

function clampConfidence(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0.7;
  return Math.max(0, Math.min(1, value));
}

function memoryFilterConditions(filter: CountMemoriesFilter): {
  conditions: string[];
  params: (string | number | null)[];
} {
  const conditions = ["guild_id = ?"];
  const params: (string | number | null)[] = [filter.guildId];

  if (filter.subjectUserId !== undefined) {
    if (filter.includeGlobal === true) {
      conditions.push("(subject_user_id = ? OR subject_user_id IS NULL)");
      params.push(filter.subjectUserId);
    } else if (filter.subjectUserId === null) {
      conditions.push("subject_user_id IS NULL");
    } else {
      conditions.push("subject_user_id = ?");
      params.push(filter.subjectUserId);
    }
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
  const result = db.raw
    .prepare(
      `INSERT INTO memories (guild_id, subject_user_id, kind, content, source_message_id, confidence, created_at, updated_at, expires_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      input.guildId,
      input.subjectUserId ?? null,
      input.kind,
      input.content,
      input.sourceMessageId ?? null,
      clampConfidence(input.confidence),
      now,
      now,
      input.expiresAt ?? null,
    );

  return Number(result.lastInsertRowid);
}

/** Update fields on an existing memory. Returns true if the row existed. */
export function updateMemory(db: Database, id: number, input: UpdateMemoryInput): boolean {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  if ("subjectUserId" in input) {
    sets.push("subject_user_id = ?");
    params.push(input.subjectUserId ?? null);
  }
  if (input.kind !== undefined) {
    sets.push("kind = ?");
    params.push(input.kind);
  }
  if (input.content !== undefined) {
    sets.push("content = ?");
    params.push(input.content);
  }
  if ("sourceMessageId" in input) {
    sets.push("source_message_id = ?");
    params.push(input.sourceMessageId ?? null);
  }
  if (input.confidence !== undefined) {
    sets.push("confidence = ?");
    params.push(clampConfidence(input.confidence));
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
  return mapRow(row);
}

/** List active memories for a guild, optionally scoped to a subject user plus global rows. */
export function listMemories(db: Database, filter: ListMemoriesFilter): MemoryRow[] {
  const { conditions, params } = memoryFilterConditions(filter);

  let sql = `SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC, id DESC`;
  if (filter.limit !== undefined && filter.limit > 0) {
    sql += " LIMIT ?";
    params.push(filter.limit);
  }

  const rows = db.raw.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(mapRow);
}

/** Count memories matching the same active/deleted/scope filters as listMemories. */
export function countMemories(db: Database, filter: CountMemoriesFilter): number {
  const { conditions, params } = memoryFilterConditions(filter);
  const row = db.raw
    .prepare(`SELECT COUNT(*) AS count FROM memories WHERE ${conditions.join(" AND ")}`)
    .get(...params) as { count: number };
  return row.count;
}

/** Count active subject-user memories per userId in a guild. */
export function countUserMemoriesByUser(db: Database, guildId: string): Map<string, number> {
  const rows = db.raw
    .prepare(
      `SELECT subject_user_id, COUNT(*) as count FROM memories
       WHERE guild_id = ? AND subject_user_id IS NOT NULL AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       GROUP BY subject_user_id`
    )
    .all(guildId, Date.now()) as Array<{ subject_user_id: string; count: number }>;

  const result = new Map<string, number>();
  for (const row of rows) {
    result.set(row.subject_user_id, row.count);
  }
  return result;
}

function mapRow(row: Record<string, unknown>): MemoryRow {
  return {
    id: Number(row.id),
    guildId: row.guild_id as string,
    subjectUserId: row.subject_user_id as string | null,
    kind: row.kind as MemoryKind,
    content: row.content as string,
    sourceMessageId: row.source_message_id as string | null,
    confidence: Number(row.confidence),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    expiresAt: row.expires_at as number | null,
    deletedAt: row.deleted_at as number | null,
  };
}
