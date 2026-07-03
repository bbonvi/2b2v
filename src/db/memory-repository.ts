import type { Database } from "./database";
import { sanitizeMemoryContent } from "./memory-content";
import type { MemoryKind } from "./memory-kinds";
export { MEMORY_KINDS, isMemoryKind, type MemoryKind } from "./memory-kinds";

export type MemoryScope = "guild" | "user" | "self";

export interface MemoryRow {
  id: number;
  scope: MemoryScope;
  guildId: string | null;
  subjectUserId: string | null;
  kind: MemoryKind;
  content: string;
  sourceMessageId: string | null;
  provenance: Record<string, unknown> | null;
  confidence: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  deletedAt: number | null;
}

export interface CreateMemoryInput {
  guildId: string;
  scope?: MemoryScope;
  subjectUserId?: string | null;
  kind: MemoryKind;
  content: string;
  sourceMessageId?: string | null;
  provenance?: Record<string, unknown> | null;
  confidence?: number;
  expiresAt?: number | null;
}

export interface UpdateMemoryInput {
  scope?: MemoryScope;
  guildId?: string | null;
  subjectUserId?: string | null;
  kind?: MemoryKind;
  content?: string;
  sourceMessageId?: string | null;
  provenance?: Record<string, unknown> | null;
  confidence?: number;
  expiresAt?: number | null;
  deletedAt?: number | null;
}

export interface ListMemoriesFilter {
  guildId: string;
  scope?: MemoryScope;
  subjectUserId?: string | null;
  includeGlobal?: boolean;
  includeSelf?: boolean;
  includeDeleted?: boolean;
  limit?: number;
}

export type CountMemoriesFilter = Omit<ListMemoriesFilter, "limit">;

function clampConfidence(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0.7;
  return Math.max(0, Math.min(1, value));
}

function scopeForSubject(subjectUserId: string | null | undefined): MemoryScope {
  return subjectUserId !== undefined && subjectUserId !== null ? "user" : "guild";
}

function createScopeFields(input: CreateMemoryInput): {
  scope: MemoryScope;
  guildId: string | null;
  subjectUserId: string | null;
} {
  const scope = input.scope ?? scopeForSubject(input.subjectUserId);
  if (scope === "self") {
    return { scope, guildId: null, subjectUserId: null };
  }
  if (scope === "user") {
    if (input.subjectUserId === undefined || input.subjectUserId === null || input.subjectUserId === "") {
      throw new Error("User-scoped memories require subjectUserId.");
    }
    return { scope, guildId: null, subjectUserId: input.subjectUserId };
  }
  return { scope, guildId: input.guildId, subjectUserId: null };
}

function assertKindScope(kind: MemoryKind, scope: MemoryScope): void {
  if (kind === "journal" && scope !== "self") {
    throw new Error("Journal memories must use self scope.");
  }
}

function updateScopeFields(input: UpdateMemoryInput): {
  scope: MemoryScope;
  guildId: string | null;
  subjectUserId: string | null;
} {
  const scope = input.scope;
  if (scope === undefined) {
    throw new Error("scope is required.");
  }
  if (scope === "self") {
    return { scope, guildId: null, subjectUserId: null };
  }
  if (scope === "user") {
    if (input.subjectUserId === undefined || input.subjectUserId === null || input.subjectUserId === "") {
      throw new Error("User-scoped memories require subjectUserId.");
    }
    return { scope, guildId: null, subjectUserId: input.subjectUserId };
  }
  if (input.guildId === undefined || input.guildId === null || input.guildId === "") {
    throw new Error("Guild-scoped memories require guildId.");
  }
  return { scope, guildId: input.guildId, subjectUserId: null };
}

function memoryFilterConditions(filter: CountMemoriesFilter): {
  conditions: string[];
  params: (string | number | null)[];
} {
  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (filter.scope === "self") {
    conditions.push("scope = 'self'");
  } else if (filter.scope === "guild") {
    conditions.push("scope = 'guild'");
    conditions.push("guild_id = ?");
    params.push(filter.guildId);
  } else if (filter.scope === "user") {
    if (filter.subjectUserId === undefined || filter.subjectUserId === null) {
      conditions.push("1 = 0");
    } else {
      conditions.push("scope = 'user'");
      conditions.push("subject_user_id = ?");
      params.push(filter.subjectUserId);
    }
  } else if (filter.subjectUserId !== undefined) {
    if (filter.includeGlobal === true) {
      const clauses = [
        "(scope = 'user' AND subject_user_id = ? AND guild_id IS NULL)",
        "(scope = 'guild' AND subject_user_id IS NULL AND guild_id = ?)",
      ];
      params.push(filter.subjectUserId);
      params.push(filter.guildId);
      if (filter.includeSelf === true) {
        clauses.push("(scope = 'self' AND subject_user_id IS NULL AND guild_id IS NULL)");
      }
      conditions.push(`(${clauses.join(" OR ")})`);
    } else if (filter.subjectUserId === null) {
      conditions.push("scope = 'guild'");
      conditions.push("subject_user_id IS NULL");
      conditions.push("guild_id = ?");
      params.push(filter.guildId);
    } else {
      conditions.push("scope = 'user'");
      conditions.push("subject_user_id = ?");
      conditions.push("guild_id IS NULL");
      params.push(filter.subjectUserId);
    }
  } else {
    conditions.push("scope = 'guild'");
    conditions.push("subject_user_id IS NULL");
    conditions.push("guild_id = ?");
    params.push(filter.guildId);
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
  const { scope, guildId, subjectUserId } = createScopeFields(input);
  assertKindScope(input.kind, scope);
  const content = sanitizeMemoryContent(input.content);
  if (content === "") {
    throw new Error("Memory content cannot be empty.");
  }
  const result = db.raw
    .prepare(
      `INSERT INTO memories (scope, guild_id, subject_user_id, kind, content, source_message_id, provenance_json, confidence, created_at, updated_at, expires_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(
      scope,
      guildId,
      subjectUserId,
      input.kind,
      content,
      input.sourceMessageId ?? null,
      input.provenance !== undefined && input.provenance !== null ? JSON.stringify(input.provenance) : null,
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
  const existing = db.raw
    .prepare("SELECT scope, kind FROM memories WHERE id = ?")
    .get(id) as { scope: MemoryScope; kind: MemoryKind } | null;
  if (existing === null) return false;
  if (input.scope === undefined && ("guildId" in input || "subjectUserId" in input)) {
    throw new Error("Changing memory scope fields requires scope.");
  }
  const effectiveScope = input.scope ?? existing.scope;
  const effectiveKind = input.kind ?? existing.kind;
  assertKindScope(effectiveKind, effectiveScope);

  if (input.scope !== undefined) {
    const scopeFields = updateScopeFields(input);
    sets.push("scope = ?");
    params.push(scopeFields.scope);
    sets.push("guild_id = ?");
    params.push(scopeFields.guildId);
    sets.push("subject_user_id = ?");
    params.push(scopeFields.subjectUserId);
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

/** List active memories by scope, optionally combining current guild and portable user rows for prompt context. */
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

/** Count active portable user memories per userId. The guild argument is kept for caller shape. */
export function countUserMemoriesByUser(db: Database, _guildId: string): Map<string, number> {
  const rows = db.raw
    .prepare(
      `SELECT subject_user_id, COUNT(*) as count FROM memories
       WHERE scope = 'user' AND guild_id IS NULL AND subject_user_id IS NOT NULL AND deleted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       GROUP BY subject_user_id`
    )
    .all(Date.now()) as Array<{ subject_user_id: string; count: number }>;

  const result = new Map<string, number>();
  for (const row of rows) {
    result.set(row.subject_user_id, row.count);
  }
  return result;
}

function mapRow(row: Record<string, unknown>): MemoryRow {
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
    scope: row.scope as MemoryScope,
    guildId: row.guild_id as string | null,
    subjectUserId: row.subject_user_id as string | null,
    kind: row.kind as MemoryKind,
    content: sanitizeMemoryContent(row.content as string),
    sourceMessageId: row.source_message_id as string | null,
    provenance,
    confidence: Number(row.confidence),
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    expiresAt: row.expires_at as number | null,
    deletedAt: row.deleted_at as number | null,
  };
}
