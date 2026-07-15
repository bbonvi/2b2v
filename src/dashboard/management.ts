import type { Database } from "../db/database";
import type { MemoryKind } from "../db/memory-kinds";
import { sanitizeMemoryContent } from "../db/memory-content";
import { listMemoryApplicability } from "../db/memory-repository";

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
  appliesTo: "all" | string[];
  kind: MemoryKind;
  content: string;
  sourceMessageId: string | null;
  sourceGuildId: string | null;
  sourceChannelId: string | null;
  provenance: Record<string, unknown> | null;
  confidence: number;
  priority: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  deletedAt: number | null;
}

export type ManagementMemoryStatus = "active" | "expired" | "deleted" | "all";

export interface ManagementMemoryFilter {
  memoryId?: number;
  guildId?: string;
  channelId?: string;
  scope?: "guild" | "user" | "self";
  kind?: MemoryKind;
  subjectUserId?: string;
  applicableToUserId?: string;
  applicabilityMode?: "all" | "users";
  status?: ManagementMemoryStatus;
  query?: string;
  limit?: number;
}

export interface ManagementMemoryCreateInput {
  scope: "guild" | "user" | "self";
  guildId?: string | null;
  subjectUserId?: string | null;
  appliesTo: "all" | string[];
  kind: MemoryKind;
  content: string;
  sourceMessageId?: string | null;
  provenance?: Record<string, unknown> | null;
  confidence: number;
  priority: number;
  expiresAt?: number | null;
}

export type ManagementMemoryEditInput = Partial<ManagementMemoryCreateInput> & {
  memoryId: number;
};

export interface DeletedStoredMessages {
  messageIds: string[];
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
  if (ids.length === 0) return { messageIds: [] };
  const idPlaceholders = placeholders(ids);
  const rows = db.raw
    .prepare(
      `SELECT id FROM messages
       WHERE id IN (${idPlaceholders}) AND guild_id = ? AND channel_id = ?
         AND is_synthetic = 0 AND is_prompt_only = 0`
    )
    .all(...ids, input.guildId, input.channelId) as Array<{ id: string }>;
  const messageIds = rows.map((row) => row.id);
  if (messageIds.length === 0) return { messageIds: [] };

  const rowPlaceholders = placeholders(messageIds);
  db.raw
    .prepare(`DELETE FROM message_assets WHERE message_id IN (${rowPlaceholders}) AND guild_id = ? AND channel_id = ?`)
    .run(...messageIds, input.guildId, input.channelId);
  db.raw
    .prepare(`DELETE FROM message_reactions WHERE message_id IN (${rowPlaceholders}) AND guild_id = ? AND channel_id = ?`)
    .run(...messageIds, input.guildId, input.channelId);
  db.raw
    .prepare(`DELETE FROM messages WHERE id IN (${rowPlaceholders}) AND guild_id = ? AND channel_id = ?`)
    .run(...messageIds, input.guildId, input.channelId);

  return { messageIds };
}

/** List memory rows across scopes for dashboard inspection and editing. */
export function listManagementMemories(
  db: Database,
  filter: ManagementMemoryFilter,
): ManagementMemoryRow[] {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (filter.memoryId !== undefined) {
    conditions.push("m.id = ?");
    params.push(filter.memoryId);
  }
  if (filter.scope !== undefined) {
    conditions.push("m.scope = ?");
    params.push(filter.scope);
  }
  if (filter.guildId !== undefined) {
    // Portable user/self memories are visible in every guild, matching the runtime context contract.
    conditions.push("(m.scope <> 'guild' OR m.guild_id = ?)");
    params.push(filter.guildId);
  }
  if (filter.channelId !== undefined) {
    conditions.push("source.channel_id = ?");
    params.push(filter.channelId);
  }
  if (filter.kind !== undefined) {
    conditions.push("m.kind = ?");
    params.push(filter.kind);
  }
  if (filter.subjectUserId !== undefined) {
    conditions.push("m.subject_user_id = ?");
    params.push(filter.subjectUserId);
  }
  if (filter.applicableToUserId !== undefined) {
    conditions.push(`(m.applicability_mode = 'all' OR EXISTS (
      SELECT 1 FROM memory_applicability filtered_applicability
      WHERE filtered_applicability.memory_id = m.id AND filtered_applicability.user_id = ?
    ))`);
    params.push(filter.applicableToUserId);
  }
  if (filter.applicabilityMode !== undefined) {
    conditions.push("m.applicability_mode = ?");
    params.push(filter.applicabilityMode);
  }
  if (filter.query !== undefined && filter.query.trim() !== "") {
    conditions.push("(m.content LIKE ? ESCAPE '\\' OR CAST(m.id AS TEXT) = ? OR m.source_message_id = ?)");
    const query = filter.query.trim();
    const escaped = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    params.push(`%${escaped}%`, query, query);
  }

  const status = filter.status ?? "active";
  if (status === "active") {
    conditions.push("m.deleted_at IS NULL");
    conditions.push("(m.expires_at IS NULL OR m.expires_at > ?)");
    params.push(Date.now());
  } else if (status === "expired") {
    conditions.push("m.deleted_at IS NULL");
    conditions.push("m.expires_at IS NOT NULL AND m.expires_at <= ?");
    params.push(Date.now());
  } else if (status === "deleted") {
    conditions.push("m.deleted_at IS NOT NULL");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db.raw
    .prepare(
      `SELECT m.id, m.scope, m.guild_id, m.subject_user_id, m.applicability_mode, m.kind, m.content, m.source_message_id,
              m.provenance_json, m.confidence, m.priority, m.created_at, m.updated_at, m.expires_at, m.deleted_at,
              source.guild_id AS source_guild_id, source.channel_id AS source_channel_id
       FROM memories m
       LEFT JOIN messages source ON source.id = m.source_message_id
       ${where}
       ORDER BY m.priority DESC, m.updated_at DESC, m.id DESC
       LIMIT ?`
    )
    .all(...params, clampLimit(filter.limit, 200, 1000)) as Array<{
      id: number;
      scope: "guild" | "user" | "self";
      guild_id: string | null;
      subject_user_id: string | null;
      applicability_mode: "all" | "users";
      kind: MemoryKind;
      content: string;
      source_message_id: string | null;
      provenance_json: string | null;
      confidence: number;
      priority: number;
      created_at: number;
      updated_at: number;
      expires_at: number | null;
      deleted_at: number | null;
      source_guild_id: string | null;
      source_channel_id: string | null;
    }>;

  const applicability = listMemoryApplicability(db, rows.map((row) => row.id));
  return rows.map((row) => {
    let provenance: Record<string, unknown> | null = null;
    if (row.provenance_json !== null && row.provenance_json.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(row.provenance_json);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          provenance = parsed as Record<string, unknown>;
        }
      } catch {
        provenance = null;
      }
    }
    return {
      id: row.id,
      scope: row.scope,
      guildId: row.guild_id,
      subjectUserId: row.subject_user_id,
      appliesTo: row.applicability_mode === "all" ? "all" : applicability.get(row.id) ?? [],
      kind: row.kind,
      content: sanitizeMemoryContent(row.content),
      sourceMessageId: row.source_message_id,
      sourceGuildId: row.source_guild_id,
      sourceChannelId: row.source_channel_id,
      provenance,
      confidence: row.confidence,
      priority: row.priority,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
      deletedAt: row.deleted_at,
    };
  });
}

/** Return exact stored memory row, including deleted rows for validation messages. */
export function getManagementMemory(db: Database, id: number): ManagementMemoryRow | null {
  return listManagementMemories(db, { memoryId: id, status: "all", limit: 1 })[0] ?? null;
}

/** Build label fallback data from persisted IDs so stale rows remain understandable. */
export function storedManagementDirectoryIds(db: Database): {
  guildIds: string[];
  channelPairs: Array<{ id: string; guildId: string }>;
  userIds: string[];
  userLabels: ManagementLabel[];
} {
  const guildIds = new Set<string>();
  const channelPairs = new Map<string, { id: string; guildId: string }>();
  const userIds = new Set<string>();
  const userLabels = new Map<string, ManagementLabel>();

  const messageRows = db.raw
    .prepare("SELECT DISTINCT guild_id, channel_id, user_id FROM messages")
    .all() as Array<{ guild_id: string; channel_id: string; user_id: string }>;
  for (const row of messageRows) {
    guildIds.add(row.guild_id);
    channelPairs.set(`${row.guild_id}:${row.channel_id}`, { id: row.channel_id, guildId: row.guild_id });
    userIds.add(row.user_id);
  }
  const usernameRows = db.raw
    .prepare(
      `SELECT user_id, author_username
       FROM messages
       WHERE is_synthetic = 0 AND is_prompt_only = 0 AND trim(author_username) <> ''
       ORDER BY created_at DESC, id DESC`
    )
    .all() as Array<{ user_id: string; author_username: string }>;
  for (const row of usernameRows) {
    if (!userLabels.has(row.user_id)) userLabels.set(row.user_id, { id: row.user_id, name: row.author_username });
  }

  const memoryRows = db.raw
    .prepare("SELECT DISTINCT guild_id, subject_user_id FROM memories")
    .all() as Array<{ guild_id: string | null; subject_user_id: string | null }>;
  for (const row of memoryRows) {
    if (row.guild_id !== null) guildIds.add(row.guild_id);
    if (row.subject_user_id !== null) userIds.add(row.subject_user_id);
  }
  const applicabilityRows = db.raw
    .prepare("SELECT DISTINCT user_id FROM memory_applicability")
    .all() as Array<{ user_id: string }>;
  for (const row of applicabilityRows) userIds.add(row.user_id);

  return {
    guildIds: [...guildIds],
    channelPairs: [...channelPairs.values()],
    userIds: [...userIds],
    userLabels: [...userLabels.values()],
  };
}
