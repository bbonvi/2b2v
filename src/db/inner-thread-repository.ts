import { randomUUID } from "node:crypto";
import type { Database } from "./database.ts";

export type InnerThreadAbout = "community" | "user" | "self";
export type InnerThreadRecallScope = "anywhere" | "guild";
export type InnerThreadRecallMode = "always" | "users";
export type InnerThreadStatus = "active" | "resolved";

export interface InnerThread {
  id: string;
  content: string;
  aboutType: InnerThreadAbout;
  aboutUserId: string | null;
  recallScope: InnerThreadRecallScope;
  recallGuildId: string | null;
  recallMode: InnerThreadRecallMode;
  recallUserIds: string[];
  salience: number;
  pressure: number;
  sourceMessageIds: string[];
  sourceGuildId: string | null;
  sourceChannelId: string | null;
  status: InnerThreadStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export interface InnerThreadWrite {
  content: string;
  aboutType: InnerThreadAbout;
  aboutUserId?: string | null;
  recallScope: InnerThreadRecallScope;
  recallGuildId?: string | null;
  recallMode: InnerThreadRecallMode;
  recallUserIds?: string[];
  salience: number;
  pressure: number;
  sourceMessageIds?: string[];
  sourceGuildId?: string | null;
  sourceChannelId?: string | null;
  expiresAt?: number | null;
}

export interface InnerThreadPatch {
  content?: string;
  aboutType?: InnerThreadAbout;
  aboutUserId?: string | null;
  recallScope?: InnerThreadRecallScope;
  recallGuildId?: string | null;
  recallMode?: InnerThreadRecallMode;
  recallUserIds?: string[];
  salience?: number;
  pressure?: number;
  sourceMessageIds?: string[];
  sourceGuildId?: string | null;
  sourceChannelId?: string | null;
  status?: InnerThreadStatus;
  expiresAt?: number | null;
}

export interface InnerThreadEvent {
  id: string;
  threadId: string;
  action: "create" | "update" | "resolve" | "delete";
  requestId: string | null;
  guildId: string | null;
  channelId: string | null;
  before: InnerThread | null;
  after: InnerThread | null;
  createdAt: number;
}

interface ThreadRow {
  id: string;
  content: string;
  about_type: InnerThreadAbout;
  about_user_id: string | null;
  recall_scope: InnerThreadRecallScope;
  recall_guild_id: string | null;
  recall_mode: InnerThreadRecallMode;
  salience: number;
  pressure: number;
  source_message_ids_json: string;
  source_guild_id: string | null;
  source_channel_id: string | null;
  status: InnerThreadStatus;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

interface EventRow {
  id: string;
  thread_id: string;
  action: InnerThreadEvent["action"];
  request_id: string | null;
  guild_id: string | null;
  channel_id: string | null;
  before_json: string | null;
  after_json: string | null;
  created_at: number;
}

function parseStringArray(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function recallUsers(db: Database, threadId: string): string[] {
  const rows = db.raw.prepare("SELECT user_id FROM inner_thread_recall_users WHERE thread_id = ? ORDER BY user_id")
    .all(threadId) as Array<{ user_id: string }>;
  return rows.map((row) => row.user_id);
}

function fromRow(db: Database, row: ThreadRow): InnerThread {
  return {
    id: row.id,
    content: row.content,
    aboutType: row.about_type,
    aboutUserId: row.about_user_id,
    recallScope: row.recall_scope,
    recallGuildId: row.recall_guild_id,
    recallMode: row.recall_mode,
    recallUserIds: recallUsers(db, row.id),
    salience: row.salience,
    pressure: row.pressure,
    sourceMessageIds: parseStringArray(row.source_message_ids_json),
    sourceGuildId: row.source_guild_id,
    sourceChannelId: row.source_channel_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function replaceRecallUsers(db: Database, threadId: string, userIds: readonly string[]): void {
  db.raw.prepare("DELETE FROM inner_thread_recall_users WHERE thread_id = ?").run(threadId);
  const insert = db.raw.prepare("INSERT INTO inner_thread_recall_users (thread_id, user_id) VALUES (?, ?)");
  for (const userId of [...new Set(userIds)].sort()) insert.run(threadId, userId);
}

function recordEvent(db: Database, input: {
  action: InnerThreadEvent["action"];
  threadId: string;
  requestId?: string;
  guildId?: string;
  channelId?: string;
  before: InnerThread | null;
  after: InnerThread | null;
  now: number;
}): void {
  db.raw.prepare(`INSERT INTO inner_thread_events
    (id, thread_id, action, request_id, guild_id, channel_id, before_json, after_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      randomUUID(),
      input.threadId,
      input.action,
      input.requestId ?? null,
      input.guildId ?? null,
      input.channelId ?? null,
      input.before === null ? null : JSON.stringify(input.before),
      input.after === null ? null : JSON.stringify(input.after),
      input.now,
    );
}

/** Create one durable private inner thread and its recall-user index. */
export function createInnerThread(db: Database, input: InnerThreadWrite & {
  requestId?: string;
  eventGuildId?: string;
  eventChannelId?: string;
  now?: number;
}): InnerThread {
  const now = input.now ?? Date.now();
  const id = `thread-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  db.raw.transaction(() => {
    db.raw.prepare(`INSERT INTO inner_threads
      (id, content, about_type, about_user_id, recall_scope, recall_guild_id, recall_mode,
       salience, pressure, source_message_ids_json, source_guild_id, source_channel_id,
       status, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
      .run(
        id,
        input.content.trim(),
        input.aboutType,
        input.aboutUserId ?? null,
        input.recallScope,
        input.recallGuildId ?? null,
        input.recallMode,
        input.salience,
        input.pressure,
        JSON.stringify(input.sourceMessageIds ?? []),
        input.sourceGuildId ?? null,
        input.sourceChannelId ?? null,
        now,
        now,
        input.expiresAt ?? null,
      );
    replaceRecallUsers(db, id, input.recallMode === "users" ? input.recallUserIds ?? [] : []);
  })();
  const created = getInnerThread(db, id);
  if (created === null) throw new Error(`Failed to create inner thread ${id}.`);
  recordEvent(db, {
    action: "create",
    threadId: id,
    requestId: input.requestId,
    guildId: input.eventGuildId,
    channelId: input.eventChannelId,
    before: null,
    after: created,
    now,
  });
  return created;
}

/** Retrieve one inner thread by its opaque ID. */
export function getInnerThread(db: Database, id: string): InnerThread | null {
  const row = db.raw.prepare("SELECT * FROM inner_threads WHERE id = ?").get(id) as ThreadRow | null;
  return row === null ? null : fromRow(db, row);
}

/** Patch one inner thread while preserving unspecified semantic fields. */
export function updateInnerThread(db: Database, id: string, patch: InnerThreadPatch, event: {
  action?: "update" | "resolve";
  requestId?: string;
  guildId?: string;
  channelId?: string;
  now?: number;
} = {}): InnerThread | null {
  const before = getInnerThread(db, id);
  if (before === null) return null;
  const next: InnerThread = {
    ...before,
    ...patch,
    aboutUserId: patch.aboutUserId !== undefined ? patch.aboutUserId : before.aboutUserId,
    recallGuildId: patch.recallGuildId !== undefined ? patch.recallGuildId : before.recallGuildId,
    recallUserIds: patch.recallUserIds ?? before.recallUserIds,
    sourceMessageIds: patch.sourceMessageIds ?? before.sourceMessageIds,
    sourceGuildId: patch.sourceGuildId !== undefined ? patch.sourceGuildId : before.sourceGuildId,
    sourceChannelId: patch.sourceChannelId !== undefined ? patch.sourceChannelId : before.sourceChannelId,
    expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : before.expiresAt,
    updatedAt: event.now ?? Date.now(),
  };
  db.raw.transaction(() => {
    db.raw.prepare(`UPDATE inner_threads SET
      content = ?, about_type = ?, about_user_id = ?, recall_scope = ?, recall_guild_id = ?,
      recall_mode = ?, salience = ?, pressure = ?, source_message_ids_json = ?,
      source_guild_id = ?, source_channel_id = ?, status = ?, updated_at = ?, expires_at = ?
      WHERE id = ?`)
      .run(
        next.content.trim(),
        next.aboutType,
        next.aboutUserId,
        next.recallScope,
        next.recallGuildId,
        next.recallMode,
        next.salience,
        next.pressure,
        JSON.stringify(next.sourceMessageIds),
        next.sourceGuildId,
        next.sourceChannelId,
        next.status,
        next.updatedAt,
        next.expiresAt,
        id,
      );
    replaceRecallUsers(db, id, next.recallMode === "users" ? next.recallUserIds : []);
  })();
  const after = getInnerThread(db, id);
  if (after !== null) {
    recordEvent(db, {
      action: event.action ?? "update",
      threadId: id,
      requestId: event.requestId,
      guildId: event.guildId,
      channelId: event.channelId,
      before,
      after,
      now: next.updatedAt,
    });
  }
  return after;
}

/** Delete one inner thread while retaining a mutation audit event. */
export function deleteInnerThread(db: Database, id: string, event: {
  requestId?: string;
  guildId?: string;
  channelId?: string;
  now?: number;
} = {}): boolean {
  const before = getInnerThread(db, id);
  if (before === null) return false;
  const now = event.now ?? Date.now();
  const changed = db.raw.prepare("DELETE FROM inner_threads WHERE id = ?").run(id).changes > 0;
  if (changed) {
    recordEvent(db, {
      action: "delete",
      threadId: id,
      requestId: event.requestId,
      guildId: event.guildId,
      channelId: event.channelId,
      before,
      after: null,
      now,
    });
  }
  return changed;
}

/** List active threads automatically applicable to one guild and visible participant set. */
export function listApplicableInnerThreads(db: Database, input: {
  guildId: string;
  visibleUserIds?: readonly string[];
  now?: number;
  limit?: number;
}): InnerThread[] {
  const now = input.now ?? Date.now();
  const visible = new Set(input.visibleUserIds ?? []);
  const rows = db.raw.prepare(`SELECT * FROM inner_threads
    WHERE status = 'active'
      AND (expires_at IS NULL OR expires_at > ?)
      AND (recall_scope = 'anywhere' OR recall_guild_id = ?)
    ORDER BY pressure DESC, salience DESC, updated_at DESC
    LIMIT ?`)
    .all(now, input.guildId, 500) as ThreadRow[];
  return rows
    .map((row) => fromRow(db, row))
    .filter((thread) => thread.recallMode === "always" || thread.recallUserIds.some((id) => visible.has(id)))
    .slice(0, Math.max(1, input.limit ?? 20));
}

/** List durable threads for private inspection and dashboard views. */
export function listInnerThreads(db: Database, input: {
  status?: InnerThreadStatus | "all";
  guildId?: string;
  limit?: number;
} = {}): InnerThread[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (input.status !== undefined && input.status !== "all") {
    conditions.push("status = ?");
    params.push(input.status);
  }
  if (input.guildId !== undefined) {
    conditions.push("(recall_scope = 'anywhere' OR recall_guild_id = ?)");
    params.push(input.guildId);
  }
  params.push(Math.max(1, input.limit ?? 100));
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.raw.prepare(`SELECT * FROM inner_threads ${where}
    ORDER BY status ASC, pressure DESC, salience DESC, updated_at DESC LIMIT ?`).all(...params) as ThreadRow[];
  return rows.map((row) => fromRow(db, row));
}

/** List recent thread mutation events for diagnostics. */
export function listInnerThreadEvents(db: Database, limit = 200): InnerThreadEvent[] {
  const rows = db.raw.prepare("SELECT * FROM inner_thread_events ORDER BY created_at DESC LIMIT ?")
    .all(Math.max(1, limit)) as EventRow[];
  return rows.map((row) => ({
    id: row.id,
    threadId: row.thread_id,
    action: row.action,
    requestId: row.request_id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    before: row.before_json === null ? null : JSON.parse(row.before_json) as InnerThread,
    after: row.after_json === null ? null : JSON.parse(row.after_json) as InnerThread,
    createdAt: row.created_at,
  }));
}
