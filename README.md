# 2b

Personal Discord bot with a single persona reply loop, native tool calling, and lightweight persistent memory. Built for small personal servers with per-guild isolation.

## What it does

- Responds to @mentions, configurable keywords, or random chance per guild
- Splits responses into multiple short messages with natural delays
- Remembers durable facts and preferences
- Stores and recalls images shared in chats
- Schedules messages (recurring, one-off, relative time)
- Searches the web via Brave Search
- Can reference server members and channel history

## Requirements

- [Bun](https://bun.sh) 1.3+
- [Docker](https://www.docker.com/) (for Qdrant)
- API keys: [Discord](https://discord.com/developers/applications), [OpenRouter](https://openrouter.ai/), optional [Brave Search](https://brave.com/search/api/) and [ElevenLabs](https://elevenlabs.io/)

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

Required: `DISCORD_TOKEN`, `OPENROUTER_API_KEY`. Optional feature keys: `BRAVE_API_KEY` for web search, `ELEVENLABS_API_KEY` for voice. See `.env.example` and `.env.prod.example` for infrastructure, dashboard, logging, and storage variables.

## Configuration

Global defaults live in optional `config/config.yaml`; copy `config/config.yaml.example` when needed. Each guild has `config/guilds/<id>-<slug>.yaml`; the guild ID is parsed from the filename, and the slug is cosmetic. Copy `config/guilds/000000000-example.yaml.example` for the full reference.

```yaml
triggers:
  mention: true
  keywords: [2b]
model: moonshotai/kimi-k2.5
timezone: UTC
adminUserIds: []
```

All fields are optional; missing values fall back to global defaults. `promptProfile` selects files from `prompts/`, with committed defaults in `prompts/persona.md` and `prompts/style.md`.

### Persona

`<voice>text</voice>` sends generated audio when ElevenLabs is configured. Text outside the voice directive is sent as normal Discord content on the audio attachment. `<ignore>reason</ignore>` sends nothing. Other XML is normal text.

## Slash commands

Most slash commands are admin-only by Discord Administrator permission or `adminUserIds`; `/vpn` is available to all users. Responses are ephemeral.

- `/status`: uptime and basic stats
- `/schedule list | add | remove`: manage guild schedules; `add` creates `admin` schedules
- `/memory-wipe`: clears guild memories and message history; requires typing `WIPE`
- `/vpn`: WireGuard profile UI; requires `vpn.enabled: true` and valid `vpn.apiUrl`/`vpn.vpnPeer`

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
