import type { Database } from "../db/database";
import type { MemoryKind } from "../db/memory-kinds";
import { sanitizeMemoryContent } from "../db/memory-content";

export interface ManagementLabel {
  id: string;
  name: string;
}

export interface ManagementChannelLabel extends ManagementLabel {
  guildId: string;
  type: string;
}

export interface ManagementDirectory {
  guilds: ManagementLabel[];
  channels: ManagementChannelLabel[];
  users: ManagementLabel[];
}

export interface ManagementMessageRow {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  authorUsername: string;
  rawContent: string;
  translatedContent: string;
  isBot: boolean;
  createdAt: number;
  replyToId: string | null;
}

export interface ManagementMemoryRow {
  id: number;
  scope: "guild" | "user" | "self";
  guildId: string | null;
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

export interface DeletedStoredMessages {
  messageIds: string[];
  imagePaths: string[];
}

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

/** Return stored Discord messages for the dashboard management list, newest first. */
export function listManagementMessages(
  db: Database,
  filter: { guildId?: string; channelId?: string; limit?: number },
): ManagementMessageRow[] {
  const conditions = ["is_synthetic = 0", "is_prompt_only = 0"];
  const params: Array<string | number> = [];
  if (filter.guildId !== undefined) {
    conditions.push("guild_id = ?");
    params.push(filter.guildId);
  }
  if (filter.channelId !== undefined) {
    conditions.push("channel_id = ?");
    params.push(filter.channelId);
  }

  const rows = db.raw
    .prepare(
      `SELECT id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id
       FROM messages
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(...params, clampLimit(filter.limit, 80, 200)) as Array<{
      id: string;
      guild_id: string;
      channel_id: string;
      user_id: string;
      author_username: string;
      raw_content: string;
      translated_content: string;
      is_bot: number;
      created_at: number;
      reply_to_id: string | null;
    }>;

  return rows.map((row) => ({
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    userId: row.user_id,
    authorUsername: row.author_username,
    rawContent: row.raw_content,
    translatedContent: row.translated_content,
    isBot: row.is_bot === 1,
    createdAt: row.created_at,
    replyToId: row.reply_to_id,
  }));
}

/** Fetch one editable/deletable stored dashboard message by exact Discord location. */
export function getManagementMessage(
  db: Database,
  input: { id: string; guildId: string; channelId: string },
): ManagementMessageRow | null {
  const row = db.raw
    .prepare(
      `SELECT id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id
       FROM messages
       WHERE id = ? AND guild_id = ? AND channel_id = ?
         AND is_synthetic = 0 AND is_prompt_only = 0`
    )
    .get(input.id, input.guildId, input.channelId) as {
      id: string;
      guild_id: string;
      channel_id: string;
      user_id: string;
      author_username: string;
      raw_content: string;
      translated_content: string;
      is_bot: number;
      created_at: number;
      reply_to_id: string | null;
    } | null;
  if (row === null) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    channelId: row.channel_id,
    userId: row.user_id,
    authorUsername: row.author_username,
    rawContent: row.raw_content,
    translatedContent: row.translated_content,
    isBot: row.is_bot === 1,
    createdAt: row.created_at,
    replyToId: row.reply_to_id,
  };
}

/** Update local SQLite content for one exact stored message. */
export function updateStoredManagementMessageContent(
  db: Database,
  input: { id: string; guildId: string; channelId: string; content: string },
): ManagementMessageRow | null {
  const content = input.content.trim();
  if (content === "") return null;
  const existing = getManagementMessage(db, input);
  if (existing === null) return null;
  db.raw
    .prepare(
      `UPDATE messages
       SET raw_content = ?, translated_content = ?
       WHERE id = ? AND guild_id = ? AND channel_id = ?
         AND is_synthetic = 0 AND is_prompt_only = 0`
    )
    .run(content, content, input.id, input.guildId, input.channelId);
  return getManagementMessage(db, input);
}

/** Delete exact stored message rows and attached metadata for one guild/channel. */
export function deleteStoredManagementMessages(
  db: Database,
  input: { ids: readonly string[]; guildId: string; channelId: string },
): DeletedStoredMessages {
  const ids = [...new Set(input.ids.filter((id) => id.trim() !== ""))];
  if (ids.length === 0) return { messageIds: [], imagePaths: [] };
  const idPlaceholders = placeholders(ids);
  const rows = db.raw
    .prepare(
      `SELECT id FROM messages
       WHERE id IN (${idPlaceholders}) AND guild_id = ? AND channel_id = ?
         AND is_synthetic = 0 AND is_prompt_only = 0`
    )
    .all(...ids, input.guildId, input.channelId) as Array<{ id: string }>;
  const messageIds = rows.map((row) => row.id);
  if (messageIds.length === 0) return { messageIds: [], imagePaths: [] };

  const rowPlaceholders = placeholders(messageIds);
  const imageRows = db.raw
    .prepare(`SELECT path FROM images WHERE message_id IN (${rowPlaceholders}) AND guild_id = ? AND channel_id = ?`)
    .all(...messageIds, input.guildId, input.channelId) as Array<{ path: string }>;

  db.raw
    .prepare(`DELETE FROM images WHERE message_id IN (${rowPlaceholders}) AND guild_id = ? AND channel_id = ?`)
    .run(...messageIds, input.guildId, input.channelId);
  db.raw
    .prepare(`DELETE FROM message_reactions WHERE message_id IN (${rowPlaceholders}) AND guild_id = ? AND channel_id = ?`)
    .run(...messageIds, input.guildId, input.channelId);
  db.raw
    .prepare(`DELETE FROM messages WHERE id IN (${rowPlaceholders}) AND guild_id = ? AND channel_id = ?`)
    .run(...messageIds, input.guildId, input.channelId);

  return { messageIds, imagePaths: imageRows.map((row) => row.path) };
}

/** List memory rows across scopes for dashboard inspection and editing. */
export function listManagementMemories(
  db: Database,
  filter: { guildId?: string; scope?: "guild" | "user" | "self"; includeDeleted?: boolean; limit?: number },
): ManagementMemoryRow[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (filter.scope !== undefined) {
    conditions.push("scope = ?");
    params.push(filter.scope);
  }
  if (filter.guildId !== undefined) {
    conditions.push("(scope <> 'guild' OR guild_id = ?)");
    params.push(filter.guildId);
  }
  if (filter.includeDeleted !== true) {
    conditions.push("deleted_at IS NULL");
    conditions.push("(expires_at IS NULL OR expires_at > ?)");
    params.push(Date.now());
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.raw
    .prepare(
      `SELECT id, scope, guild_id, subject_user_id, kind, content, source_message_id, confidence,
              created_at, updated_at, expires_at, deleted_at
       FROM memories
       ${where}
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`
    )
    .all(...params, clampLimit(filter.limit, 200, 1000)) as Array<{
      id: number;
      scope: "guild" | "user" | "self";
      guild_id: string | null;
      subject_user_id: string | null;
      kind: MemoryKind;
      content: string;
      source_message_id: string | null;
      confidence: number;
      created_at: number;
      updated_at: number;
      expires_at: number | null;
      deleted_at: number | null;
    }>;

  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    guildId: row.guild_id,
    subjectUserId: row.subject_user_id,
    kind: row.kind,
    content: sanitizeMemoryContent(row.content),
    sourceMessageId: row.source_message_id,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    deletedAt: row.deleted_at,
  }));
}

/** Return exact stored memory row, including deleted rows for validation messages. */
export function getManagementMemory(db: Database, id: number): ManagementMemoryRow | null {
  const rows = listManagementMemories(db, { includeDeleted: true, limit: 1000 });
  return rows.find((row) => row.id === id) ?? null;
}

/** Build label fallback data from persisted IDs so stale rows remain understandable. */
export function storedManagementDirectoryIds(db: Database): {
  guildIds: string[];
  channelPairs: Array<{ id: string; guildId: string }>;
  userIds: string[];
} {
  const guildIds = new Set<string>();
  const channelPairs = new Map<string, { id: string; guildId: string }>();
  const userIds = new Set<string>();

  const messageRows = db.raw
    .prepare("SELECT DISTINCT guild_id, channel_id, user_id FROM messages")
    .all() as Array<{ guild_id: string; channel_id: string; user_id: string }>;
  for (const row of messageRows) {
    guildIds.add(row.guild_id);
    channelPairs.set(`${row.guild_id}:${row.channel_id}`, { id: row.channel_id, guildId: row.guild_id });
    userIds.add(row.user_id);
  }

  const memoryRows = db.raw
    .prepare("SELECT DISTINCT guild_id, subject_user_id FROM memories")
    .all() as Array<{ guild_id: string | null; subject_user_id: string | null }>;
  for (const row of memoryRows) {
    if (row.guild_id !== null) guildIds.add(row.guild_id);
    if (row.subject_user_id !== null) userIds.add(row.subject_user_id);
  }

  return {
    guildIds: [...guildIds],
    channelPairs: [...channelPairs.values()],
    userIds: [...userIds],
  };
}
