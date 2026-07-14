# 2b

Personal Discord bot.

## Requirements

- [Bun](https://bun.sh) 1.3+
- [Docker](https://www.docker.com/) for container runs
- Discord bot token
- Credentials for the configured LLM provider
- Optional feature keys in `.env.example`

## Quick Start

```bash
cp .env.example .env
cp profiles/2b/guilds/000000000-example.yaml.example profiles/2b/guilds/<YOUR_GUILD_ID>-<slug>.yaml
```

Set `PROFILE=2b` or `PROFILE=delamain` in the environment file used by the stack.

Development:

```bash
docker compose -f docker-compose.dev.yml up -d --build --remove-orphans
```

Production:

```bash
cp .env.prod.example .env.prod
docker compose --env-file .env.prod -p 2b2v-prod up -d --build --remove-orphans
```

Each profile runs as a separate Compose project using the same generic service. Give every environment file a distinct `PROFILE`, `DISCORD_TOKEN`, `DASHBOARD_PORT`, and project name; project-scoped volumes keep their data isolated:

```bash
docker compose --env-file .env.prod.del -p 2b2v-delamain-prod up -d --build --remove-orphans
```

Do not run multiple stacks with the same Discord bot token unless they should connect as the same bot.

## Environment

Required: `DISCORD_TOKEN` and credentials for the selected LLM provider.

The default provider is OpenRouter via `OPENROUTER_API_KEY`. `llmProvider: openai-codex` uses ChatGPT subscription OAuth from `CODEX_AUTH_PATH` or `data/codex-auth.json`:

```bash
bun run codex:login -- --auth data/codex-auth.json
```

Inside the dev container:

```bash
docker compose -f docker-compose.dev.yml exec bot bun run codex:login -- --auth data/codex-auth.json
```

Treat Codex auth JSON as a secret. See `.env.example` and `.env.prod.example` for optional keys and infrastructure settings.

## Profiles

Each profile owns its configuration, guild overrides, and persona-specific instructions. Shared runtime instructions live alongside them:

- `profiles/2b/config.yaml`, `profiles/2b/guilds/`, and `profiles/2b/instructions/`
- `profiles/delamain/config.yaml` and `profiles/delamain/instructions/`
- `profiles/shared/instructions/`

Select the complete profile with one environment variable:

```bash
PROFILE=2b bun run dev
PROFILE=delamain bun run dev
```

The Delamain profile disables relationships, ambient memory extraction, ambient attention, and VPN. Its ambient initiative is bot-audience only and targets the configured 2B Discord account; `botPressure` is a signed additive bias on those initiative opportunities. Profile-specific instruction files override shared files at the same relative path; skill packs override by manifest ID.

Minimal guild config:

```yaml
triggers:
  mention: true
  keywords: [2b]
llmProvider: openrouter
model: moonshotai/kimi-k2.5
timezone: UTC
adminUserIds: []
```

All config fields are optional unless the matching feature needs credentials or IDs. `PROFILE` selects configuration and instructions together.

Message uploads, embeds, and stickers appear in history and current-event metadata as typed references such as `Images: #12 photo.png` and `Audio: #13 voice.ogg`. Media is fetched lazily from Discord. Text and timestamped transcripts support regex search plus bounded line reads; `assetReading` controls output/download limits, per-kind timeouts, transcription duration, and video preview frames. Docker images include FFmpeg and ripgrep for media preview and safe regex search.

Web visuals use `search_images` for Brave image discovery, `fetch_url` for readable Markdown plus preserved page-image URLs, and `fetch_images` for ephemeral inspection. Inspected public image URLs can be supplied to image generation as `reference_urls`; animated images use a static first-frame reference. `externalImages` controls download, redirect, size, dimension, and page-image limits.

Verification:

```bash
make check-profiles
make check
make test
```

`make test-unit` skips integration tests for faster targeted loops.
