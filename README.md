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
cp config/config.yaml.example config/config.yaml
cp config/guilds/000000000-example.yaml.example config/guilds/<YOUR_GUILD_ID>-<slug>.yaml
```

Development:

```bash
docker compose -f docker-compose.dev.yml up -d --build --remove-orphans
```

Production:

```bash
cp .env.prod.example .env.prod
docker compose -p 2b2v-prod --env-file .env.prod -f docker-compose.yml up -d --build --remove-orphans
```

Use `-p 2b2v-prod` for production so dev and prod containers/volumes stay separate. Do not run dev and prod with the same Discord bot token unless both stacks should connect as the same bot.

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

## Configuration

Copy and edit the example files:

- Global defaults: `config/config.yaml`
- Guild config: `config/guilds/<id>-<slug>.yaml`
- Persona/style prompts: `prompts/core/`
- Runtime policy prompts: `prompts/runtime/`

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

All fields are optional unless the matching feature needs credentials or IDs. Live config files are ignored by git except committed `.example` files.

Message uploads, embeds, and stickers appear in history as typed short IDs (`ImgIDs`, `GIFIDs`, `AudioIDs`, `VideoIDs`, `TextIDs`, `FileIDs`). Media is fetched lazily from Discord; `assetReading` in the global or guild YAML controls text/transcript page size, download limits, transcription duration, and video preview frames.

Verification:

```bash
make check
make test
```

`make test-unit` skips integration tests for faster targeted loops.
