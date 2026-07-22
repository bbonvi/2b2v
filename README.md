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

Required: `DISCORD_TOKEN` and credentials for every provider declared in `modelProfiles`.

OpenRouter profiles use `OPENROUTER_API_KEY`. Profiles with `provider: openai-codex` use ChatGPT subscription OAuth from `CODEX_AUTH_PATH` or `data/codex-auth.json`:

```bash
bun run codex:login -- --auth data/codex-auth.json
```

Inside the dev container:

```bash
docker compose -f docker-compose.dev.yml exec bot bun run codex:login -- --auth data/codex-auth.json
```

Treat Codex auth JSON as a secret. See `.env.example` and `.env.prod.example` for optional keys and infrastructure settings.

## Live Voice

The 2B profile can keep one global Discord voice presence. It receives account-attributed Opus streams, converts them once to 16 kHz mono, and uses local stateful Silero VAD to forward only confirmed speech to ElevenLabs Scribe Realtime. Silence and ending pauses remain local; a monthly forwarded-audio cap switches cleanly to a lazily loaded faster-whisper `small` INT8 fallback. Short turns from `voice.modelProfile` then stream ElevenLabs Flash audio back to Discord; `voice.playback` controls source volume, the initial receive prebuffer, and the leading/trailing Opus silence frames. Final text transcripts, summaries, audible output prefixes, STT usage, and cross-channel instructions are durable; raw microphone audio is never persisted. The voice model receives a six-hour, 160-event buffer from recent visits to the same channel, with second-precision event times and 2B and participant join/leave boundaries rendered inline. Multi-person attention remains owned by the person who addressed 2B, while bounded non-owner chatter cannot indefinitely starve her response opportunity; silent `<|>` yield boundaries let an interruption stop at a coherent point rather than an arbitrary word. Rolling summaries and durable memory/relationship extraction use their independent `voice.maintenance.*.modelProfile` policies and cadences.

Enable the Discord `GuildVoiceStates` intent and give the bot Connect/Speak permissions. `ELEVENLABS_API_KEY` is required. The Voice dashboard exposes connection health, participants, chronological room history, output/interruption state, the exact outbound Luna request context, durable instructions, join/leave controls, and gated synthetic input. The test-only `/voice text:...` command is registered only in `voice.testing.guildIds`.

`list_channels` includes voice rooms and their current members. Text turns can call `join_voice_channel`, `leave_voice_channel`, and `instruct_voice_channel`; the instruction result is asynchronous and closes through a reply to the original text message. Live voice turns can move or leave their own single presence after the current spoken turn, while a persisted private handoff carries only bounded source-room continuity into the destination. They can also start image jobs, which are delivered to the guild's default text channel and remain visible to the originating voice context through job status. Only the 2B profile enables this runtime by default.

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

The Delamain profile disables private life, relationships, inner threads, ambient memory extraction, ambient attention, and VPN. Ambient initiative gives the normal actor a general autonomous opportunity; configured `botContactIds` are available contacts, not mandatory targets or a separate bot-only mode. Profile-specific instruction files override shared files at the same relative path; skill packs override by manifest ID.

Minimal guild config:

```yaml
triggers:
  mention: true
  keywords: [2b]
modelProfile: main
timezone: UTC
adminUserIds: []
```

Top-level `modelProfiles` entries are complete execution policies: provider, model, model parameters, reasoning level, service tier, Codex transport, and prompt-caching behavior. Workloads and guilds select one by name through `modelProfile`; live voice, voice summary, voice extraction, ambient evaluators, memory, relationships, image reading, and image generation may each select different profiles. All config fields are optional unless the matching feature needs credentials or IDs. `PROFILE` selects configuration and instructions together.

`innerThreads.enabled` defaults to `true` and can be overridden per guild. Set it to `false` to remove inner-thread prompt context and tools and to skip inner-thread maintenance.

Top-level `privateLife.enabled` controls one profile-wide private curiosity loop. Its cadence, night rates, visible-output budget and cooldown, tool budget, novelty window, selector weights, action-scope weights, recent-room age and history limits, and retained private-thought duration are configurable under `privateLife`. Action scopes independently weight reflection, quiet exploration, private action, and social opportunity; social output is disabled during sleep and after recent visible bot activity. Spontaneous opportunities use no chat history. Recent-residue opportunities select among the five accessible channels where the bot speaks most, require recent human activity, and use bounded history. Inner-thread opportunities use their grounded source room when one exists. It uses the execution guild's local time and runs much less often during the sleep window. Prompt Lab can override the execution location; automatic config cannot pin it. Set `enabled: false` to disable its scheduler, selector, episode storage, and maintenance. The universal `<thoughts>` response block is separate: it remains available in ordinary turns and is always removed from visible output. Malformed private blocks fail closed.

Profiles may define ordered `personaModes`. Later active modes override earlier ones, while `default` names the always-available global fallback regardless of its list position. Modes are `global` by default; `scope: guild` gives every guild an independent episode plan, active state, aftermath, and server avatar override. Guild-scoped modes cannot set presence because Discord presence is account-wide. A mode can use a daily local-time `scheduledWindow` or a preplanned `triggeredEpisode`; episodes activate only on a natural agent turn during their persisted opportunity and never force a message. Durations accept `ms`, `s`, `m`, `h`, or `d` units, such as `100s`, `30m`, or `7d`.

Mode assets are convention-based under `profiles/<profile>/modes/<id>/`: provide `avatar.png`, `.jpg`, or `.webp`, with optional random alternatives such as `avatar-1.png`. Instructions normally stay inline in YAML; they may be omitted or empty for presentation-only modes. `instructions.md`, `lead-in.md`, and `aftermath.md` are supported when a longer phase warrants a file. Optional avatar rotation, Discord presence/activity, lead-in, and aftermath are configured per mode. `minInterval` and `maxInterval` plan the next opportunity from mode initialization or the previous cycle; after an episode actually runs, `cooldown` delays the baseline from which that next interval is measured. It never delays the first plan or a replacement for a missed opportunity. Scheduling-field or timezone changes hot-replan pending episodes, while instruction and presentation edits preserve their planned time. Added modes start their own interval when loaded, and avatar candidate or rotation changes reconcile without racing stale updates. The dashboard shows global and guild-local active modes, planned transitions or opportunities, aftermath, selected avatars, presence, avatar retry state, and the next scheduled global avatar reroll.

Message uploads, embeds, and stickers appear in history and current-event metadata as typed references such as `Images: #12 photo.png` and `Audio: #13 voice.ogg`. Media is fetched lazily from Discord. Text and timestamped transcripts support regex search plus bounded line reads; `assetReading` controls output/download limits, per-kind timeouts, transcription duration, and video preview frames. Docker images include FFmpeg and ripgrep for media preview and safe regex search.

Conversational dice requests use the shared `roll_dice` agent tool without a slash command or persistent panel. It uses cryptographic randomness, supports optional total-at-least target checks, free-form traits and established actor nicknames, and records an idempotent local audit row. Public rolls post a localized Discord Components V2 card; private rolls post no widget and create a prompt-only history event. Both use untranslated `<dice_roll visibility="public|private"/>` records in prompt history while each profile's database stays isolated.

Web visuals use `search_images` for Brave image discovery, `fetch_url` for readable Markdown plus preserved page-image URLs, and `fetch_images` for ephemeral inspection. Image generation accepts one ordered `reference_images` list containing lazy chat assets, inspected public URLs, or current-guild avatars identified by the canonical user ID returned from `read_user_avatar`; animated images use a static first-frame reference. `externalImages` controls download, redirect, size, dimension, and page-image limits.

Async agent jobs are durable and channel-scoped. `list_agent_jobs` returns active or recent work, while `read_agent_job` exposes the exact effective input, lifecycle, result, replacement lineage, and output assets. Generated image assets retain their producer-job link, so `read_asset` returns both the image and its generation provenance for later revisions; unlinked terminal jobs expire after 30 days.

Verification:

```bash
make check-profiles
make check
make test
```

`make test-unit` skips integration tests for faster targeted loops.
