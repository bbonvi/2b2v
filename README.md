# 2b

Personal Discord bot with a single persona reply loop, native tool calling, and lightweight persistent memory. Built for small personal servers with per-guild isolation.

## What it does

- Responds to @mentions, configurable keywords, or random chance per guild
- Splits responses into multiple short messages with natural delays
- Remembers durable facts and preferences
- Stores and recalls images shared in chats
- Generates images through Codex subscription auth and stores bot images like chat images
- Schedules messages (recurring, one-off, relative time)
- Searches the web via Brave Search
- Reads webpages and extracts YouTube/media transcripts for summaries
- Can reference server members and channel history

## Requirements

- [Bun](https://bun.sh) 1.3+
- [Docker](https://www.docker.com/) (for Qdrant)
- API keys: [Discord](https://discord.com/developers/applications), OpenRouter by default, optional ChatGPT/Codex subscription auth, [Brave Search](https://brave.com/search/api/), and [ElevenLabs](https://elevenlabs.io/)
- Optional for local non-Docker media extraction: latest `yt-dlp`, plus `ffmpeg` only for media fallback transcription, chunking, or slide extraction. The Docker image installs standalone `yt-dlp`.

## Quick start

```bash
# 1. Copy and fill in secrets
cp .env.example .env

# 2. Create local config and prompts from examples
cp config/config.yaml.example config/config.yaml
cp config/guilds/000000000-example.yaml.example config/guilds/<YOUR_GUILD_ID>-<slug>.yaml
cp prompts/persona.md.example prompts/persona.md
cp prompts/style.md.example prompts/style.md
# Edit these files to match your setup and bot persona

# 3a. Development (live reload, debug logging; uses .env)
docker compose -f docker-compose.dev.yml up -d --build
# After the first build, src/, prompts/, and config/ edits restart the app via Bun watch.

# 3b. Production (separate project, volumes, env, dashboard port)
cp .env.prod.example .env.prod
# Edit .env.prod with production secrets first.
docker compose -p 2b2v-prod --env-file .env.prod -f docker-compose.yml up -d --build
```

Use the dev compose file for live reload. Use the production command with `-p 2b2v-prod` so prod containers and volumes are separate from the default dev project. Production bind-mounts `./config` and `./prompts` from this checkout read-only, matching development's single source of truth. Do not run dev and prod with the same Discord bot token unless you intentionally want both stacks connected as the same bot.

The Docker image caches `yt-dlp` between builds. Refresh it explicitly with `docker compose -p 2b2v-prod --env-file .env.prod -f docker-compose.yml build --build-arg YT_DLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux?cache-bust=$(date -Iseconds)" bot`.

## Environment variables

Required: `DISCORD_TOKEN` plus credentials for the configured LLM provider. The default provider is OpenRouter, which requires `OPENROUTER_API_KEY`; `llmProvider: openai-codex` uses ChatGPT subscription OAuth credentials from `CODEX_AUTH_PATH` or `data/codex-auth.json`. Run `bun run codex:login -- --auth data/codex-auth.json` locally, or `docker compose -f docker-compose.dev.yml exec bot bun run codex:login -- --auth data/codex-auth.json` for the dev container volume. Treat the Codex auth JSON as a secret. The `codex_generate_image` tool also uses this Codex subscription auth, targets `gpt-image-2` through the Codex image backend, can pass stored chat `ImageIDs` as reference images, and does not require `OPENAI_API_KEY`. In Discord it starts an async image job: the bot acknowledges immediately, keeps typing while the worker runs, then replies to the original message with the generated image or a failure/timeout notice. Optional feature keys: `BRAVE_API_KEY` for web search, `ELEVENLABS_API_KEY` for voice. Optional media transcription fallbacks can use `GROQ_API_KEY`, `ASSEMBLYAI_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `FAL_KEY`. See `.env.example` and `.env.prod.example` for infrastructure, dashboard, logging, and storage variables.

## Configuration

Global defaults live in optional `config/config.yaml`; copy `config/config.yaml.example` and edit it locally. Each guild has `config/guilds/<id>-<slug>.yaml`; the guild ID is parsed from the filename, and the slug is cosmetic. Copy `config/guilds/000000000-example.yaml.example` for the full reference. Live `config/*.yaml` files are ignored by git except for committed `.example` files.

```yaml
triggers:
  mention: true
  keywords: [2b]
llmProvider: openrouter # or openai-codex
model: moonshotai/kimi-k2.5
timezone: UTC
adminUserIds: []
```

All fields are optional; missing values fall back to global defaults. `promptProfile` selects files from `prompts/`. Live prompt files are local and ignored by git; copy `prompts/persona.md.example` to `prompts/persona.md` and `prompts/style.md.example` to `prompts/style.md`, then customize them for your bot.

### Persona

`<message>text</message>` separates an intentional multi-message reply; plain text remains a single message. Per-message delivery can use `reply="false"` for a normal channel send, `reply_to="<message id>"` to reply to a specific Discord message, or `keep_typing="true"` to keep typing while more messages are expected. Closed `<message>` envelopes in streamed assistant answers are sent as soon as they arrive; streamed follow-up bubbles are paced behind typing so buffered messages do not visually collapse into one burst. `<voice>text</voice>` or `<audio>text</audio>` sends generated audio when ElevenLabs is configured. Text outside the voice/audio directive is sent as normal Discord content on the audio attachment. `<ignore>reason</ignore>` sends nothing. Other XML is normal text. `[msg-break]` is a history-only marker for merged separate messages, not an output directive.

## History Search Maintenance

Semantic message search stores normalized message text in Qdrant and keeps readable content in SQLite. Vector payloads include useful filters such as user, chat, time, bot/human author, source (`live`, `backfill`, `reindex`), and granularity (`single`, `merged`).

Repair or rebuild message vectors from SQLite:

```bash
bun scripts/reindex-message-vectors.ts --guild <GUILD_ID> [--channel <CHANNEL_ID>]
bun scripts/reindex-message-vectors.ts --guild <GUILD_ID> [--channel <CHANNEL_ID>] --apply
```

Production one-off example:

```bash
docker compose -p 2b2v-prod --env-file .env.prod -f docker-compose.yml run --rm --no-deps \
  -v "$PWD/scripts:/app/scripts:ro" \
  bot bun scripts/reindex-message-vectors.ts --guild <GUILD_ID> --channel <CHANNEL_ID> --apply
```

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
- No bot-side rate limiting on LLM calls beyond the selected provider's own limits
- Requires Discord message content intent for full functionality

## License

TBD
