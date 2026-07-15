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

The Delamain profile disables relationships, ambient memory extraction, ambient attention, and VPN. Its ambient initiative is bot-audience only and targets the configured 2B Discord account. Normal ambient initiative may also address configured bots; `botPressure` is a signed additive bias applied only to those bot-directed opportunities. Profile-specific instruction files override shared files at the same relative path; skill packs override by manifest ID.

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

Profiles may define ordered `personaModes`. Later active modes override earlier ones, while `default` names the always-available global fallback regardless of its list position. Modes are `global` by default; `scope: guild` gives every guild an independent episode plan, active state, aftermath, and server avatar override. Guild-scoped modes cannot set presence because Discord presence is account-wide. A mode can use a daily local-time `scheduledWindow` or a preplanned `triggeredEpisode`; episodes activate only on a natural agent turn during their persisted opportunity and never force a message. Durations accept `ms`, `s`, `m`, `h`, or `d` units, such as `100s`, `30m`, or `7d`.

Mode assets are convention-based under `profiles/<profile>/modes/<id>/`: provide `avatar.png`, `.jpg`, or `.webp`, with optional random alternatives such as `avatar-1.png`. Instructions normally stay inline in YAML; they may be omitted or empty for presentation-only modes. `instructions.md`, `lead-in.md`, and `aftermath.md` are supported when a longer phase warrants a file. Optional avatar rotation, Discord presence/activity, lead-in, and aftermath are configured per mode. `minInterval` and `maxInterval` plan the next opportunity from mode initialization or the previous cycle; after an episode actually runs, `cooldown` delays the baseline from which that next interval is measured. It never delays the first plan or a replacement for a missed opportunity. Scheduling-field or timezone changes hot-replan pending episodes, while instruction and presentation edits preserve their planned time. Added modes start their own interval when loaded, and avatar candidate or rotation changes reconcile without racing stale updates. The dashboard shows global and guild-local active modes, planned transitions or opportunities, aftermath, selected avatars, presence, and avatar retry state.

Message uploads, embeds, and stickers appear in history and current-event metadata as typed references such as `Images: #12 photo.png` and `Audio: #13 voice.ogg`. Media is fetched lazily from Discord. Text and timestamped transcripts support regex search plus bounded line reads; `assetReading` controls output/download limits, per-kind timeouts, transcription duration, and video preview frames. Docker images include FFmpeg and ripgrep for media preview and safe regex search.

Web visuals use `search_images` for Brave image discovery, `fetch_url` for readable Markdown plus preserved page-image URLs, and `fetch_images` for ephemeral inspection. Image generation accepts one ordered `reference_images` list containing lazy chat assets, inspected public URLs, or current-guild avatars identified by the canonical user ID returned from `read_user_avatar`; animated images use a static first-frame reference. `externalImages` controls download, redirect, size, dimension, and page-image limits.

Async agent jobs are durable and channel-scoped. `list_agent_jobs` returns active or recent work, while `read_agent_job` exposes the exact effective input, lifecycle, result, replacement lineage, and output assets. Generated image assets retain their producer-job link, so `read_asset` returns both the image and its generation provenance for later revisions; unlinked terminal jobs expire after 30 days.

Verification:

```bash
make check-profiles
make check
make test
```

`make test-unit` skips integration tests for faster targeted loops.
