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

/** Build the current staged-output table for fresh databases and legacy table-copy migrations. */
export function stagedAssetsTableSql(tableName: string, ifNotExists = false): string {
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${tableName} (
    ref                  TEXT PRIMARY KEY,
    job_id               TEXT NOT NULL UNIQUE REFERENCES agent_jobs(id) ON DELETE CASCADE,
    owner_guild_id       TEXT NOT NULL,
    owner_channel_id     TEXT NOT NULL,
    filename             TEXT NOT NULL,
    content_type         TEXT NOT NULL,
    storage_path         TEXT NOT NULL,
    created_at           INTEGER NOT NULL,
    expires_at           INTEGER NOT NULL,
    delivered_message_id TEXT,
    permanent_asset_id   INTEGER REFERENCES message_assets(id)
  )`;
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

  CREATE TABLE IF NOT EXISTS inner_threads (
    id                      TEXT PRIMARY KEY,
    content                 TEXT NOT NULL CHECK(length(trim(content)) > 0),
    about_type              TEXT NOT NULL CHECK(about_type IN ('community', 'user', 'self')),
    about_user_id           TEXT,
    recall_scope            TEXT NOT NULL CHECK(recall_scope IN ('anywhere', 'guild')),
    recall_guild_id         TEXT,
    recall_mode             TEXT NOT NULL CHECK(recall_mode IN ('always', 'users')),
    salience                REAL NOT NULL CHECK(salience >= 0 AND salience <= 1),
    pressure                REAL NOT NULL CHECK(pressure >= 0 AND pressure <= 1),
    source_message_ids_json TEXT NOT NULL DEFAULT '[]',
    source_guild_id         TEXT,
    source_channel_id       TEXT,
    status                  TEXT NOT NULL CHECK(status IN ('active', 'resolved')),
    created_at              INTEGER NOT NULL,
    updated_at              INTEGER NOT NULL,
    expires_at              INTEGER,
    CHECK((about_type = 'user' AND about_user_id IS NOT NULL) OR (about_type IN ('self', 'community') AND about_user_id IS NULL)),
    CHECK((recall_scope = 'anywhere' AND recall_guild_id IS NULL) OR (recall_scope = 'guild' AND recall_guild_id IS NOT NULL))
  );

  CREATE INDEX IF NOT EXISTS idx_inner_threads_scope_status
    ON inner_threads(recall_scope, recall_guild_id, status, pressure, updated_at);

  CREATE TABLE IF NOT EXISTS inner_thread_recall_users (
    thread_id TEXT NOT NULL REFERENCES inner_threads(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL,
    PRIMARY KEY (thread_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_inner_thread_recall_users_user
    ON inner_thread_recall_users(user_id, thread_id);

  CREATE TABLE IF NOT EXISTS inner_thread_events (
    id                TEXT PRIMARY KEY,
    thread_id         TEXT NOT NULL,
    action            TEXT NOT NULL CHECK(action IN ('create', 'update', 'resolve', 'delete')),
    request_id        TEXT,
    guild_id          TEXT,
    channel_id        TEXT,
    before_json       TEXT,
    after_json        TEXT,
    created_at        INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_inner_thread_events_created
    ON inner_thread_events(created_at, thread_id);

  CREATE TABLE IF NOT EXISTS private_life_episodes (
    id                      TEXT PRIMARY KEY,
    guild_id                TEXT NOT NULL,
    channel_id              TEXT NOT NULL,
    request_id              TEXT,
    status                  TEXT NOT NULL CHECK(status IN ('running', 'complete', 'failed')),
    day_phase               TEXT NOT NULL CHECK(day_phase IN ('day', 'late-night', 'sleep-window')),
    origin                  TEXT NOT NULL,
    mode                    TEXT NOT NULL,
    territory               TEXT NOT NULL,
    action_scope            TEXT NOT NULL,
    candidate_seeds_json    TEXT NOT NULL DEFAULT '[]',
    continued_thread_id     TEXT,
    thoughts_text           TEXT,
    summary_label           TEXT,
    theme_key               TEXT,
    facets_json             TEXT NOT NULL DEFAULT '[]',
    visible_output          TEXT,
    visible_delivered       INTEGER NOT NULL DEFAULT 0 CHECK(visible_delivered IN (0, 1)),
    created_at              INTEGER NOT NULL,
    completed_at            INTEGER,
    error                   TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_private_life_episodes_created
    ON private_life_episodes(created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_private_life_episodes_theme
    ON private_life_episodes(theme_key, created_at DESC);

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
    ON messages(guild_id, channel_id, created_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_messages_guild_time
    ON messages(guild_id, created_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_messages_time
    ON messages(created_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_messages_user_guild
    ON messages(user_id, guild_id);

  CREATE TABLE IF NOT EXISTS dice_rolls (
    id                   TEXT PRIMARY KEY,
    request_key          TEXT NOT NULL UNIQUE,
    guild_id             TEXT NOT NULL,
    channel_id           TEXT NOT NULL,
    source_message_id    TEXT NOT NULL,
    result_message_id    TEXT UNIQUE,
    requested_by_user_id TEXT NOT NULL,
    actor_user_id        TEXT NOT NULL,
    actor_username       TEXT NOT NULL,
    actor_name           TEXT,
    count                INTEGER NOT NULL CHECK(count BETWEEN 1 AND 100),
    sides                INTEGER NOT NULL CHECK(sides BETWEEN 2 AND 1000000),
    modifier             INTEGER NOT NULL CHECK(modifier BETWEEN -1000000 AND 1000000),
    mode                 TEXT NOT NULL CHECK(mode IN ('normal', 'advantage', 'disadvantage')),
    label                TEXT CHECK(label IS NULL OR length(label) <= 500),
    trait                TEXT CHECK(trait IS NULL OR length(trait) <= 100),
    lang                 TEXT NOT NULL DEFAULT 'en' CHECK(lang IN ('en', 'ru')),
    is_private           INTEGER NOT NULL DEFAULT 0 CHECK(is_private IN (0, 1)),
    rolls_json           TEXT NOT NULL,
    kept_json            TEXT NOT NULL,
    total                INTEGER NOT NULL,
    target               INTEGER,
    succeeded            INTEGER CHECK(succeeded IS NULL OR succeeded IN (0, 1)),
    created_at           INTEGER NOT NULL,
    delivered_at         INTEGER,
    CHECK((target IS NULL AND succeeded IS NULL) OR (target IS NOT NULL AND succeeded IS NOT NULL))
  );

  CREATE INDEX IF NOT EXISTS idx_dice_rolls_scope_time
    ON dice_rolls(guild_id, channel_id, created_at);

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

  ${stagedAssetsTableSql("staged_assets", true)};

  CREATE INDEX IF NOT EXISTS idx_staged_assets_owner
    ON staged_assets(owner_guild_id, owner_channel_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_staged_assets_expiry
    ON staged_assets(expires_at);

  CREATE TABLE IF NOT EXISTS voice_sessions (
    id                         TEXT PRIMARY KEY,
    guild_id                   TEXT NOT NULL,
    channel_id                 TEXT NOT NULL,
    state                      TEXT NOT NULL CHECK(state IN ('connecting', 'active', 'ended', 'failed')),
    started_at                 INTEGER NOT NULL,
    ended_at                   INTEGER,
    rolling_summary            TEXT NOT NULL DEFAULT '',
    summary_through_segment_id INTEGER,
    final_summary              TEXT NOT NULL DEFAULT '',
    handoff_json               TEXT,
    error                      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_voice_sessions_scope_time
    ON voice_sessions(guild_id, channel_id, started_at);

  CREATE TABLE IF NOT EXISTS voice_participants (
    session_id      TEXT NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL,
    username        TEXT NOT NULL,
    joined_at       INTEGER NOT NULL,
    left_at         INTEGER,
    present_at_start INTEGER NOT NULL DEFAULT 0 CHECK(present_at_start IN (0, 1)),
    PRIMARY KEY(session_id, user_id, joined_at)
  );

  CREATE INDEX IF NOT EXISTS idx_voice_participants_user
    ON voice_participants(user_id, joined_at);

  CREATE TABLE IF NOT EXISTS voice_instructions (
    id                      TEXT PRIMARY KEY,
    status                  TEXT NOT NULL CHECK(status IN ('queued', 'active', 'waiting', 'resolved', 'ignored', 'interrupted', 'failed')),
    instruction             TEXT NOT NULL,
    source_guild_id         TEXT NOT NULL,
    source_channel_id       TEXT NOT NULL,
    source_message_id       TEXT NOT NULL,
    source_message_text     TEXT NOT NULL,
    requester_id            TEXT NOT NULL,
    requester_username      TEXT NOT NULL,
    target_session_id       TEXT NOT NULL REFERENCES voice_sessions(id),
    created_at              INTEGER NOT NULL,
    activated_at            INTEGER,
    last_progress_at        INTEGER,
    resolved_at             INTEGER,
    result_summary          TEXT,
    report_message_id       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_voice_instructions_session_status
    ON voice_instructions(target_session_id, status, created_at);

  CREATE TABLE IF NOT EXISTS voice_transcript_segments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    instruction_id  TEXT REFERENCES voice_instructions(id),
    user_id         TEXT NOT NULL,
    username        TEXT NOT NULL,
    started_at      INTEGER NOT NULL,
    ended_at        INTEGER NOT NULL,
    raw_text        TEXT NOT NULL,
    normalized_text TEXT NOT NULL,
    language        TEXT NOT NULL,
    confidence      REAL,
    stt_model       TEXT NOT NULL,
    source          TEXT NOT NULL CHECK(source IN ('stt', 'test_injection')),
    synthetic       INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_voice_segments_session_time
    ON voice_transcript_segments(session_id, started_at);

  CREATE INDEX IF NOT EXISTS idx_voice_segments_speaker_time
    ON voice_transcript_segments(user_id, started_at);

  CREATE TABLE IF NOT EXISTS voice_stt_usage (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    provider    TEXT NOT NULL CHECK(provider IN ('elevenlabs', 'faster-whisper')),
    model       TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    audio_ms    INTEGER NOT NULL CHECK(audio_ms >= 0),
    outcome     TEXT NOT NULL CHECK(outcome IN ('committed', 'failed')),
    error       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_voice_stt_usage_provider_time
    ON voice_stt_usage(provider, started_at);

  CREATE INDEX IF NOT EXISTS idx_voice_stt_usage_session_time
    ON voice_stt_usage(session_id, started_at);

  CREATE TABLE IF NOT EXISTS voice_output_turns (
    id                     TEXT PRIMARY KEY,
    session_id             TEXT NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    instruction_id         TEXT REFERENCES voice_instructions(id),
    trigger_segment_id     INTEGER REFERENCES voice_transcript_segments(id),
    planned_text           TEXT NOT NULL,
    audible_text           TEXT NOT NULL DEFAULT '',
    started_at             INTEGER NOT NULL,
    ended_at               INTEGER,
    interrupted_at         INTEGER,
    interrupted_by_user_id TEXT,
    cutoff                 INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_voice_output_turns_session_time
    ON voice_output_turns(session_id, started_at);

  CREATE TABLE IF NOT EXISTS voice_runtime_events (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id         TEXT NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    trigger_segment_id INTEGER REFERENCES voice_transcript_segments(id),
    output_turn_id     TEXT REFERENCES voice_output_turns(id) ON DELETE CASCADE,
    phase              TEXT NOT NULL,
    occurred_at        INTEGER NOT NULL,
    duration_ms        INTEGER,
    detail_json        TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_voice_runtime_events_session_time
    ON voice_runtime_events(session_id, occurred_at, id);

  CREATE TABLE IF NOT EXISTS voice_maintenance_checkpoints (
    session_id        TEXT NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
    kind              TEXT NOT NULL CHECK(kind IN ('summary', 'memory', 'relationship')),
    through_segment_id INTEGER NOT NULL DEFAULT 0,
    last_run_at       INTEGER NOT NULL,
    PRIMARY KEY(session_id, kind)
  );

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
