# 2b

Personal Discord bot with a single persona reply loop, native tool calling, and lightweight persistent memory. Built for small personal servers with per-guild isolation.

## What it does

- Responds to @mentions, configurable keywords, or random chance per guild
- Speaks in character while staying helpful and grounded
- Splits responses into multiple short messages with natural delays
- Remembers durable facts and preferences by injecting global and current-user memories into prompt context
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

# 2. Create guild config from example
cp config/guilds/000000000-example.yaml.example config/guilds/<YOUR_GUILD_ID>-<slug>.yaml
# Edit it to match your setup

# 3a. Development (live reload, debug logging; uses .env)
docker compose -f docker-compose.dev.yml up -d --build
# After the first build, src/, prompts/, and config/ edits restart the app via Bun watch.

# 3b. Production (separate project, volumes, env, dashboard port)
cp .env.prod.example .env.prod
# Edit .env.prod with production secrets first.
mkdir -p ~/.local/share/2b2v
cp -a config prompts ~/.local/share/2b2v/
docker compose -p 2b2v-prod --env-file .env.prod -f docker-compose.yml up -d --build
```

Use the dev compose file for live reload. Use the production command with `-p 2b2v-prod` so prod containers and volumes are separate from the default dev project. Production config and prompts default to `~/.local/share/2b2v/{config,prompts}` and are watched by the app through bind mounts. Do not run dev and prod with the same Discord bot token unless you intentionally want both stacks connected as the same bot.

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
| `DASHBOARD_PORT` | no | dev `31457`, prod `31456` | Host port published by Compose for the dashboard |
| `DASHBOARD_PASSWORD` | no | — | Dashboard password; dashboard is disabled when unset |
| `DASHBOARD_PASSWORDLESS_CIDRS` | no | — | Comma/whitespace-separated IPv4 CIDRs that bypass dashboard login |
| `DASHBOARD_TRUSTED_PROXY_CIDRS` | no | — | Proxy CIDRs whose forwarded client IP headers may be trusted |
| `APP_CONFIG_DIR` | no | `~/.local/share/2b2v/config` | Production Compose host config directory |
| `APP_PROMPTS_DIR` | no | `~/.local/share/2b2v/prompts` | Production Compose host prompt directory |

## Configuration

### Main config (optional)

Global defaults live in `config/config.yaml` (optional). See `config/config.yaml.example` for the full list of fields. Per-guild configs override these defaults.

Stable instruction sources are selected via `promptProfile` in `config/config.yaml`. The committed defaults live in `prompts/`: `persona.md` defines the bot voice, and `style.md` holds reply-style rules. `toolInstructions` is optional and empty by default.

### Per-guild config

Each guild has a YAML file at `config/guilds/<id>-<slug>.yaml`. The guild ID is parsed from the filename; the slug is cosmetic.

```yaml
triggers:
  mention: true
  keywords: [2b, yorha]
  randomChance: 0.02
  keywordDebounceMs: 2500
  typingIdleMs: 10000
  typingMaxWaitMs: 15000
model: moonshotai/kimi-k2.5
thinkingLevel: medium
timezone: UTC
trim:
  trimTrigger: 200
  trimTarget: 150
  windowSize: 20
  messageCharLimit: 200
  replyQuoteChars: 50
promptCaching:
  enabled: true
backgroundLlm:
  model: google/gemini-2.5-flash
  serviceTier: flex
  modelParams:
    temperature: 0.1
replyLoop:
  maxToolCalls: 16
  wallClockTimeoutMs: 240000
  llmOutputTimeoutMs: 60000
mergeMessageGapSeconds: 120
adminUserIds: []
imageMaxDimension: 768
imageReadMaxPerCall: 10
imageReading:
  fallbackEnabled: true
  fallbackModel: moonshotai/kimi-k2.5
```

All fields are optional — missing values fall back to global defaults.

`promptCaching.enabled` controls stable-prefix caching. Stable prompt sections are merged into the first system message, explicit `cache_control` breakpoints are added inside that stable block, then a tiny stable cache anchor is inserted before volatile turn context.
`backgroundLlm` controls memory extraction; omitted fields inherit the main effective model config, and `serviceTier` is omitted unless explicitly set.
`imageReading.fallbackEnabled` makes image tools ask `imageReading.fallbackModel` for a detailed description when the main model cannot read image input; the description is returned to the main model as tool text.
`replyLoop.maxToolCalls` and `replyLoop.wallClockTimeoutMs` bound each native tool-calling reply run. The default is high enough for normal chained web work such as search, fetch, then answer. When the tool-call budget is exhausted, the model gets a final no-tools turn to answer from the context it already has.
`replyLoop.llmOutputTimeoutMs` limits each individual LLM turn. LLM turn timeouts and empty final model responses are retried up to three total attempts before the bot posts a short `[SYSTEM ERROR]` message in Discord.

### Persona

By default, `promptProfile.persona` points to `prompts/persona.md` and `promptProfile.lateInstructions` points to `prompts/style.md`. The same model call speaks as the persona and uses native OpenRouter tool calls when it needs search, history, schedules, images, members, URLs, or threads.

The runtime reserves two XML-like response directives: `<voice>text</voice>` sends generated audio, and `<ignore>reason</ignore>` sends nothing. Text outside a voice directive is sent as normal Discord message content on the audio attachment, so pings and links should stay outside `<voice>`. Eleven v3 delivery tags such as `[slow]`, `[sings]`, `[whispers]`, or `[amused]` belong inside `<voice>...</voice>` and are passed through to TTS/history. Other XML remains normal text; literal examples of reserved tags should be escaped as `&lt;voice&gt;` or `&lt;ignore&gt;`.

Directive edge cases are handled app-side: fenced blocks containing reserved tags are unwrapped, Discord mention tokens inside `<voice>` are moved back to text content instead of being spoken, nested `<voice>` tags are split into separate sends, legacy voice attributes are ignored, unclosed `<voice>` runs to the end of the response, unmatched closing tags stay as text, empty directive bodies are skipped, and voice/TTS failures fall back to text. Sent voice messages are stored back into chat history as `<voice>` XML so later context still shows they were audio. Any `<ignore>` directive suppresses the whole reply. General XML that does not use reserved tag names is not parsed.

## Slash commands

Most slash commands are admin-only (Discord Administrator permission or per-guild `adminUserIds` fallback). The exception is `/vpn`, which is available to all users. Responses are ephemeral.

### `/status`

Shows uptime and basic stats.

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

## Verification

Use this default verification flow after changes:

```bash
make check
make test
```

`make test-unit` is optional for targeted non-Qdrant loops. Do not run it redundantly after a passing `make test` unless you need that separate signal.

## Known limitations

- Semantic search time-range filtering is approximate
- Embedding model download requires internet access on first startup
- Designed for small personal servers (2–3 guilds, small member count) — not load-tested for large servers
- No rate limiting on LLM calls beyond OpenRouter's own limits
- Requires Discord message content intent for full functionality

## License

TBD
