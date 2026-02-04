# 2b

Personal agentic Discord bot that plays a character persona (default: 2B from NieR:Automata) while giving genuinely useful answers. Built for small personal servers with per-guild isolation and a long-lived memory system.

## What it does

- Responds to @mentions, configurable keywords, or random chance per guild
- Speaks in character while staying helpful and grounded
- Splits responses into multiple short messages with natural delays
- Remembers conversations and facts with scoped, searchable memory
- Stores and recalls images shared in chats
- Schedules messages (recurring, one-off, relative time)
- Searches the web via Brave Search
- Can reference server members and channel history when permitted

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

Use the dev compose file for live reload, and the production compose file for long-running deployments.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | yes | — | Discord bot token |
| `OPENROUTER_API_KEY` | yes | — | OpenRouter API key |
| `BRAVE_API_KEY` | no | — | Brave Search API key (enables web search) |
| `ELEVENLABS_API_KEY` | no | — | ElevenLabs API key (enables voice messages) |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn`, `error` |
| `QDRANT_URL` | no | `http://localhost:6333` | Qdrant server URL |
| `DATA_DIR` | no | `data` | Directory for SQLite database files |
| `MODEL_CACHE_DIR` | no | `model-cache` | Directory for embedding model downloads |

## Configuration

### Main config (optional)

Global defaults live in `config/config.yaml` (optional). See `config/config.yaml.example` for the full list of fields. Per-guild configs override these defaults.

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
| `imageReadMaxPerCall` | number | Max images per image read |
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

## Architecture

See `ARCHITECTURE.md` for system design, core flows, and component boundaries.

## Known limitations

- Semantic search time-range filtering is approximate
- Embedding model download requires internet access on first startup
- Designed for small personal servers (2–3 guilds, small member count) — not load-tested for large servers
- No rate limiting on LLM calls beyond OpenRouter's own limits
- Requires Discord message content intent for full functionality

## License

TBD
