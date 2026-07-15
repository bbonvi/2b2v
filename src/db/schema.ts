import { MEMORY_KIND_SQL_VALUES, MEMORY_KINDS } from "./memory-kinds";

export const SCRATCHPAD_EXPIRY_CHECK_SQL = "CHECK(kind <> 'scratchpad' OR expires_at IS NOT NULL)";
export const JOURNAL_ABOUT_CHECK_SQL = "CHECK(kind <> 'journal' OR about_type = 'self')";
export const MEMORY_ABOUT_CHECK_SQL = "CHECK((about_type = 'user' AND about_user_id IS NOT NULL) OR (about_type IN ('self', 'community') AND about_user_id IS NULL))";
export const MEMORY_RECALL_LOCATION_CHECK_SQL = "CHECK((recall_scope = 'anywhere' AND recall_guild_id IS NULL) OR (recall_scope = 'guild' AND recall_guild_id IS NOT NULL))";
export const COMMUNITY_RECALL_CHECK_SQL = "CHECK(about_type <> 'community' OR recall_scope = 'guild')";
export const MEMORY_PRIORITY_CHECK_SQL = "CHECK(priority >= 0)";
export const MEMORY_RECALL_MODE_CHECK_SQL = "CHECK(recall_mode IN ('always', 'users'))";

/** Build the current memories table shape for fresh schema creation and table-copy migrations. */
export function memoriesTableSql(tableName: string, ifNotExists = false): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${tableName} (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    about_type        TEXT NOT NULL CHECK(about_type IN ('community', 'user', 'self')),
    about_user_id     TEXT,
    recall_scope      TEXT NOT NULL CHECK(recall_scope IN ('anywhere', 'guild')),
    recall_guild_id   TEXT,
    recall_mode       TEXT NOT NULL DEFAULT 'always',
    kind              TEXT NOT NULL CHECK(kind IN (${MEMORY_KIND_SQL_VALUES})),
    content           TEXT NOT NULL CHECK(length(trim(content)) > 0),
    source_message_id TEXT,
    provenance_json   TEXT,
    confidence        REAL NOT NULL DEFAULT 0.7 CHECK(confidence >= 0 AND confidence <= 1),
    priority          INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    expires_at        INTEGER,
    deleted_at        INTEGER,
    ${SCRATCHPAD_EXPIRY_CHECK_SQL},
    ${JOURNAL_ABOUT_CHECK_SQL},
    ${MEMORY_ABOUT_CHECK_SQL},
    ${MEMORY_RECALL_LOCATION_CHECK_SQL},
    ${COMMUNITY_RECALL_CHECK_SQL},
    ${MEMORY_PRIORITY_CHECK_SQL},
    ${MEMORY_RECALL_MODE_CHECK_SQL}
  )`;
}

/** Detect legacy memories tables that need a copy migration into the current checked shape. */
export function memorySchemaHasCurrentChecks(sql: string | undefined): boolean {
  return sql !== undefined
    && MEMORY_KINDS.every((kind) => sql.includes(`'${kind}'`))
    && sql.includes("about_type")
    && sql.includes("'self'")
    && sql.includes("'community'")
    && !sql.includes("'project'")
    && sql.includes(SCRATCHPAD_EXPIRY_CHECK_SQL)
    && sql.includes(JOURNAL_ABOUT_CHECK_SQL)
    && sql.includes(MEMORY_ABOUT_CHECK_SQL)
    && sql.includes(MEMORY_RECALL_LOCATION_CHECK_SQL)
    && sql.includes(COMMUNITY_RECALL_CHECK_SQL)
    && sql.includes(MEMORY_PRIORITY_CHECK_SQL)
    && sql.includes(MEMORY_RECALL_MODE_CHECK_SQL)
    && sql.includes("CHECK(length(trim(content)) > 0)");
}

export const SCHEMA_SQL = `
  ${memoriesTableSql("memories", true)};

  CREATE TABLE IF NOT EXISTS memory_recall_users (
    memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL,
    PRIMARY KEY (memory_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_memory_recall_users_user
    ON memory_recall_users(user_id, memory_id);

  CREATE TABLE IF NOT EXISTS messages (
    id                  TEXT PRIMARY KEY,
    guild_id            TEXT NOT NULL,
    channel_id          TEXT NOT NULL,
    user_id             TEXT NOT NULL,
    author_username     TEXT NOT NULL,
    raw_content         TEXT NOT NULL,
    translated_content  TEXT NOT NULL,
    is_bot              INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL,
    reply_to_id         TEXT,
    is_synthetic        INTEGER NOT NULL DEFAULT 0,
    is_prompt_only      INTEGER NOT NULL DEFAULT 0,
    related_thread_id   TEXT,
    routed_from_guild_id   TEXT,
    routed_from_channel_id TEXT,
    routed_from_message_id TEXT,
    assets_indexed_at   INTEGER,
    deleted_at          INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_messages_guild_channel_time
    ON messages(guild_id, channel_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_messages_user_guild
    ON messages(user_id, guild_id);

  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id    TEXT NOT NULL,
    guild_id      TEXT NOT NULL,
    channel_id    TEXT NOT NULL,
    emoji_key     TEXT NOT NULL,
    emoji_label   TEXT NOT NULL,
    count         INTEGER NOT NULL CHECK(count >= 0),
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (message_id, emoji_key)
  );

  CREATE INDEX IF NOT EXISTS idx_message_reactions_message
    ON message_reactions(message_id);

  CREATE TABLE IF NOT EXISTS codex_reasoning_continuations (
    guild_id          TEXT NOT NULL,
    channel_id        TEXT NOT NULL,
    user_id           TEXT NOT NULL,
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    session_id        TEXT NOT NULL,
    source_message_id TEXT,
    payload_json      TEXT NOT NULL,
    created_at        INTEGER NOT NULL,
    PRIMARY KEY (guild_id, channel_id, user_id, provider, model, session_id)
  );

  CREATE INDEX IF NOT EXISTS idx_codex_reasoning_continuations_created
    ON codex_reasoning_continuations(created_at);

  CREATE TABLE IF NOT EXISTS restart_recovery (
    singleton   INTEGER PRIMARY KEY CHECK(singleton = 1),
    cutoff_at  INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS memory_extraction_checkpoints (
    guild_id                 TEXT NOT NULL,
    channel_id               TEXT NOT NULL,
    last_message_id          TEXT,
    last_message_created_at  INTEGER NOT NULL DEFAULT 0,
    last_run_at              INTEGER NOT NULL DEFAULT 0,
    maintenance_cursor_id    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS relationship_profiles (
    user_id          TEXT PRIMARY KEY,
    axes_json        TEXT NOT NULL,
    notes_json       TEXT NOT NULL,
    boundaries_json  TEXT NOT NULL,
    open_loops_json  TEXT NOT NULL,
    recent_json      TEXT NOT NULL,
    updated_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS relationship_events (
    id            TEXT PRIMARY KEY,
    type          TEXT NOT NULL CHECK(type = 'relationship_signal'),
    at_ms         INTEGER NOT NULL,
    source        TEXT NOT NULL CHECK(source IN ('system', 'llm', 'admin')),
    visibility    TEXT NOT NULL CHECK(visibility IN ('source-bound', 'relationship-private', 'private-internal')),
    guild_id      TEXT,
    channel_id    TEXT,
    user_id       TEXT,
    summary       TEXT NOT NULL,
    payload_json  TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_relationship_profiles_updated
    ON relationship_profiles(updated_at);

  CREATE INDEX IF NOT EXISTS idx_relationship_events_scope
    ON relationship_events(guild_id, channel_id, user_id, at_ms);

  CREATE TABLE IF NOT EXISTS schedules (
    id                TEXT PRIMARY KEY,
    guild_id          TEXT NOT NULL,
    channel_id        TEXT NOT NULL,
    source            TEXT NOT NULL CHECK(source IN ('admin', 'bot', 'tool')),
    type              TEXT NOT NULL CHECK(type IN ('cron', 'one_off')),
    cron_expression   TEXT,
    run_at            INTEGER,
    timezone          TEXT NOT NULL DEFAULT 'UTC',
    message_content   TEXT NOT NULL,
    created_by_user_id TEXT,
    created_by_username TEXT,
    handoff_note      TEXT NOT NULL DEFAULT '',
    fire_count        INTEGER NOT NULL DEFAULT 0,
    expires_at        INTEGER,
    max_fire_count    INTEGER,
    enabled           INTEGER NOT NULL DEFAULT 1,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_schedules_guild_enabled
    ON schedules(guild_id, enabled);

  CREATE INDEX IF NOT EXISTS idx_schedules_guild_channel_enabled
    ON schedules(guild_id, channel_id, enabled);

  CREATE TABLE IF NOT EXISTS persona_mode_context_state (
    scope_key    TEXT PRIMARY KEY,
    state_json   TEXT NOT NULL,
    updated_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_jobs (
    id                      TEXT PRIMARY KEY,
    kind                    TEXT NOT NULL,
    guild_id                TEXT NOT NULL,
    channel_id              TEXT NOT NULL,
    delivery_guild_id       TEXT NOT NULL,
    delivery_channel_id     TEXT NOT NULL,
    requester_id            TEXT NOT NULL,
    requester_username      TEXT NOT NULL,
    source_message_id       TEXT NOT NULL,
    source_quote            TEXT NOT NULL,
    status                  TEXT NOT NULL,
    input_json              TEXT NOT NULL,
    result_json             TEXT,
    error                   TEXT,
    created_at              INTEGER NOT NULL,
    started_at              INTEGER,
    completed_at            INTEGER,
    sent_message_id         TEXT,
    replacement_root_job_id TEXT,
    replaces_job_id         TEXT,
    replacement_count       INTEGER NOT NULL DEFAULT 0,
    cancel_reason           TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_agent_jobs_source_scope
    ON agent_jobs(guild_id, channel_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_agent_jobs_delivery_scope
    ON agent_jobs(delivery_guild_id, delivery_channel_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_agent_jobs_status
    ON agent_jobs(status, created_at);

  CREATE TABLE IF NOT EXISTS message_assets (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id            TEXT NOT NULL,
    guild_id              TEXT NOT NULL,
    channel_id            TEXT NOT NULL,
    source_kind           TEXT NOT NULL CHECK(source_kind IN ('attachment', 'embed', 'sticker')),
    source_key            TEXT NOT NULL,
    kind                  TEXT NOT NULL CHECK(kind IN ('image', 'gif', 'audio', 'video', 'text', 'file')),
    filename              TEXT,
    content_type          TEXT,
    size                  INTEGER,
    width                 INTEGER,
    height                INTEGER,
    duration_seconds      REAL,
    extracted_text        TEXT,
    extraction_provider   TEXT,
    extracted_at          INTEGER,
    created_at            INTEGER NOT NULL,
    UNIQUE(message_id, source_kind, source_key)
  );

  CREATE INDEX IF NOT EXISTS idx_message_assets_message
    ON message_assets(message_id);

  CREATE INDEX IF NOT EXISTS idx_message_assets_guild_channel
    ON message_assets(guild_id, channel_id);

  CREATE TABLE IF NOT EXISTS agent_job_assets (
    job_id   TEXT NOT NULL REFERENCES agent_jobs(id) ON DELETE CASCADE,
    asset_id INTEGER NOT NULL REFERENCES message_assets(id) ON DELETE CASCADE,
    role     TEXT NOT NULL,
    PRIMARY KEY (job_id, asset_id, role)
  );

  CREATE INDEX IF NOT EXISTS idx_agent_job_assets_asset
    ON agent_job_assets(asset_id, job_id);

  CREATE TABLE IF NOT EXISTS asset_backfill_checkpoints (
    channel_id          TEXT PRIMARY KEY,
    guild_id            TEXT NOT NULL,
    before_message_id   TEXT,
    completed_at        INTEGER,
    updated_at          INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS threads (
    thread_id           TEXT PRIMARY KEY,
    guild_id            TEXT NOT NULL,
    parent_chat_id      TEXT NOT NULL,
    starter_message_id  TEXT NOT NULL,
    thread_name         TEXT NOT NULL,
    created_at          INTEGER NOT NULL,
    last_activity_at    INTEGER NOT NULL,
    message_count       INTEGER NOT NULL DEFAULT 0,
    last_message_id     TEXT,
    bot_participating   INTEGER NOT NULL DEFAULT 0,
    created_by_bot      INTEGER NOT NULL DEFAULT 1,
    archived_at         INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_threads_parent_chat
    ON threads(parent_chat_id);

  CREATE INDEX IF NOT EXISTS idx_threads_guild
    ON threads(guild_id);

`;
