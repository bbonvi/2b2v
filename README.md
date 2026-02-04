# 2b

Personal agentic Discord bot that plays a character persona (default: 2B from NieR:Automata) while giving genuinely useful answers. Built for small personal servers with per-guild isolation and a long-lived memory system.

## What it does

- Responds to @mentions, configurable keywords, or random chance per guild
- Speaks in character while staying helpful and grounded
- Splits responses into multiple short messages with natural delays
- Stores images locally with stable IDs; LLM retrieves on demand via `read_chat_images` tool
- Fetches external images by URL via `fetch_images` tool (ephemeral, not stored)
- Remembers conversations and facts with scoped, searchable memory
- Schedules messages (recurring, one-off, relative time)
- Searches the web via Brave Search
- Inspects server members and channel history when permitted

## Requirements

- [Bun](https://bun.sh) 1.3+
- [Docker](https://www.docker.com/) (for Qdrant)
- API keys: [Discord](https://discord.com/developers/applications), [OpenRouter](https://openrouter.ai/), [Brave Search](https://brave.com/search/api/) (optional)

## Quick start

```bash
# 1. Copy and fill in secrets
cp .env.example .env

# 2. Create persona and guild config from examples
cp config/persona.md.example config/persona.md
cp config/guilds/000000000-example.yaml.example config/guilds/<YOUR_GUILD_ID>-<slug>.yaml
# Edit both files to match your setup

# 3a. Development (live reload, debug logging)
bun install   # required — dev container bind-mounts host node_modules/
docker compose -f docker-compose.dev.yml up --build

# 3b. Production
docker compose up --build -d
```

Dev mounts `src/` and `config/` from the host for live editing. Prod copies source into the image and persists data via Docker volumes (`bot-data`, `model-cache`, `qdrant-data`).

Both profiles start a Qdrant service and wait for it to be healthy before launching the bot.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | yes | — | Discord bot token |
| `OPENROUTER_API_KEY` | yes | — | OpenRouter API key |
| `BRAVE_API_KEY` | no | — | Brave Search API key (enables `web_search` tool) |
| `ELEVENLABS_API_KEY` | no | — | ElevenLabs API key (enables voice messages) |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error` |
| `QDRANT_URL` | no | `http://localhost:6333` | Qdrant server URL |
| `DATA_DIR` | no | `data` | Directory for SQLite database files |
| `MODEL_CACHE_DIR` | no | `model-cache` | Directory for embedding model downloads |

## Configuration

### Global defaults

Global defaults (model, thinking level, timezone, trim thresholds, etc.) are set in `src/config/loader.ts` and can be influenced by environment variables. Per-guild configs override these.

### Per-guild config

Each guild has a YAML file at `config/guilds/<id>-<slug>.yaml`. The guild ID is parsed from the filename; the slug is cosmetic.

```yaml
triggers:
  mention: true
  keywords: [2b, yorha]
  randomChance: 0.02
model: moonshotai/kimi-k2.5
thinkingLevel: medium
timezone: UTC
trim:
  trimTrigger: 200
  trimTarget: 150
  windowSize: 20
  messageCharLimit: 200
  replyQuoteChars: 50
mergeMessageGapSeconds: 120
memoryRetentionDays: 180
adminUserIds: []
imageMaxDimension: 768
imageReadMaxPerCall: 10
```

All fields are optional — missing values fall back to global defaults.

### Persona

The persona is a freeform markdown file at `config/persona.md`. It defines the bot's character, tone, and behavioral rules. The real file is gitignored; `config/persona.md.example` is committed as a template.

## Slash commands

Most slash commands are admin-only (Discord Administrator permission or per-guild `adminUserIds` fallback). The exception is `/vpn`, which is available to all users. Responses are ephemeral.

### `/status`

Shows uptime and basic stats.

### `/config list | get <key> | set <key> <value>`

View or modify guild settings at runtime. Changes persist to the guild YAML file.

Configurable keys:

| Key | Type | Description |
|---|---|---|
| `model` | string | OpenRouter model ID |
| `thinkingLevel` | string | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `timezone` | string | IANA timezone for schedules |
| `triggers.mention` | boolean | Respond to @mentions |
| `triggers.keywords` | string[] | Comma-separated keyword list |
| `triggers.randomChance` | number | 0–1, probability of random response |
| `trim.trimTrigger` | number | Message count that triggers trimming |
| `trim.trimTarget` | number | Message count after trimming |
| `memoryRetentionDays` | number | Default TTL for non-journal memories |
| `imageMaxDimension` | number | Max image dimension in pixels before resize |
| `trim.windowSize` | number | Recent (uncached) history window size |
| `trim.messageCharLimit` | number | Max chars per message before trimming |
| `trim.replyQuoteChars` | number | Max chars for reply quotes |
| `mergeMessageGapSeconds` | number | Max gap for merging consecutive messages |
| `imageReadMaxPerCall` | number | Max images per `read_chat_images` call |
| `imageCaptioningEnabled` | boolean | Enable image captioning (TBD) |
| `attachmentsDir` | string | Image storage directory |

### `/schedule list | add | remove`

Manage scheduled messages for the guild.

- **`add`**: Create a recurring (cron) or one-off (timestamp) schedule. Source is always `admin`.
- **`list`**: Shows all guild schedules including bot-created ones.
- **`remove <id>`**: Delete a schedule by ID.

### `/memory-wipe`

Clears all guild-scoped memories and message history. Requires typing `WIPE` as confirmation.

### `/vpn`

WireGuard VPN profile management (available to all users). Opens an interactive panel with buttons:

- **Create profile** — Select a server region and create a new WireGuard profile
- **List profiles** — View existing profiles, download config (zip), show QR code, or delete
- **Help** — Usage instructions (Russian)

Each user can have up to 16 profiles. The UI is ephemeral and only the invoking user can interact with it. Requires `vpn.enabled: true` and valid `vpn.apiUrl`/`vpn.vpnPeer` in config.

## Agent tools

The bot has access to these tools during conversations. The LLM decides when and how to use them — they are not user-invokable commands.

| Tool | Description |
|---|---|
| `send_message` | Send message to the channel |
| `save_journal` | Create or update a bot journal entry |
| `delete_journal` | Delete a journal entry by ID |
| `save_user_memory` | Create or update a user memory (by username) |
| `delete_user_memory` | Delete a user memory by ID |
| `recall_user_memories` | Retrieve user memories (by username, not in context by default) |
| `search_messages` | Semantic search over message history with guild/username/channel/time filters |
| `schedule_message` | Schedule a one-off message in N seconds/minutes/hours |
| `list_members` | List server members (all or online-only) |
| `channel_history` | Fetch recent messages from the current channel |
| `read_chat_images` | Retrieve stored chat images by ID (base64) |
| `fetch_images` | Fetch external images by URL (ephemeral, not stored) |
| `fetch_url` | Fetch a URL and extract its readable content as markdown |
| `web_search` | Search the web via Brave Search API |

Note: `send_message` supports optional voice message parameters (`is_voice_message`, `voice_type`) when TTS is configured.

## Memory system

Memories are stored in SQLite with two scopes:

- **user** — per-user facts (e.g., preferences, names). Requires `username`. NOT in LLM context — retrieve with `recall_user_memories`.
- **journal** — bot's internal journal entries. Always visible in LLM context under "## Journal".

The Server Members list shows memory count per user (e.g., `@alice — Alice — 3 memories`), helping the LLM know when to use `recall_user_memories`.

Default TTL is 180 days, configurable per guild via `memoryRetentionDays`. Individual entries can override TTL via `ttlDays` (pass `null` for no expiry). Expired memories are cleaned up periodically.

## Semantic search

Message history is stored in SQLite (raw + translated content) and embedded via a local `bge-m3` model into Qdrant. Semantic search uses pre-filtered KNN in Qdrant, then joins results back to SQLite for display metadata.

Filters available: guild (always applied), user, channel, time range.

The embedding model is downloaded on first startup and cached in `MODEL_CACHE_DIR`.

## Scheduling

Three scheduling modes:

1. **Cron** — recurring schedules with per-guild timezone support
2. **One-off** — absolute timestamp, auto-disabled after firing
3. **Relative** — "in N seconds/minutes/hours" via the `schedule_message` agent tool

Schedules are stored in SQLite and executed by a Croner-based engine. Past one-offs are auto-disabled on startup without firing.

## Translation layer

Discord markup is automatically translated in both directions:

- **Inbound** (Discord → LLM): `<@123>` → `@username`, `<#456>` → `#channel-name`, custom emojis → `:name:`, timestamps → human-readable
- **Outbound** (LLM → Discord): `@username` → `<@123>`, `#channel` → `<#456>`, `:emoji:` → custom emoji markup

Failed lookups fall back to plain text with warnings logged.

## Context management

The system prompt is composed as ordered sections: persona → tool instructions → emojis → members → journal summaries → upcoming schedules → older history → newer history → current context. The current message is sent as `role=user`. Each section carries `cache_control` metadata; stable sections (persona through older history) are cached, newer history and current context are uncached. Sections are ordered to maximize Anthropic's prefix-based prompt caching.

Chat history is split into two deterministic slices:
- **Older** (cached): `trimTarget - windowSize` messages, stable between trim events
- **Newer** (uncached): `windowSize` most recent messages

When history reaches `trimTrigger`, the oldest messages are dropped to `trimTarget`. Consecutive plain messages by the same author within `mergeMessageGapSeconds` are merged. Long messages are trimmed to `messageCharLimit` with a marker including the message ID for later retrieval via `search_messages(id)`.

Reply context is embedded with short quotes (capped at `replyQuoteChars`). Missing reply targets are fetched from Discord API and persisted. No inline images in context — messages reference `image_ids`, and the LLM uses `read_chat_images` to fetch stored images on demand, or `fetch_images` to fetch external URLs (ephemeral, not stored).

## Testing

```bash
make test               # starts Qdrant container if needed, runs all tests
make test-unit          # runs only non-Qdrant tests (no container needed)
make check              # tsc --noEmit && eslint
```

`make test` automatically starts a `qdrant-test` container and sets `QDRANT_URL` for the test run, overriding any `.env` value. Manage the container manually with `make qdrant-up` / `make qdrant-down`.

## Known limitations

- Semantic search does not support time-range filtering at the Qdrant level (tracked as v1 TODO; currently filters in application layer)
- Embedding model download requires internet access on first startup
- Designed for small personal servers (2–3 guilds, small member count) — not load-tested for large servers
- No rate limiting on LLM calls beyond OpenRouter's own limits
- Message content intent required for full functionality; missing intent triggers degraded mode with a runtime warning

## License

TBD
