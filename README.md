# 2b

Personal agentic Discord bot that plays a character persona (default: 2B from NieR:Automata) while giving genuinely useful answers. Built for small personal servers with per-guild isolation and a long-lived memory system.

## What it does
- Responds to @mentions, configurable keywords, or random chance per guild
- Speaks in character while staying helpful and grounded
- Splits responses into multiple short messages for a more human feel
- Understands images and sends multimodal context to the LLM

## Implementation status
All features described below are planned. Implementation is in progress.

## Core features
- Bun + discord.js runtime
- OpenRouter LLM with per-guild model overrides and passthrough params
- Persona-driven system prompt with cache-aware context window trimming
- Memory system with SQLite + Qdrant (user, guild, global, journal)
- Semantic search over message history via Qdrant with pre-filtered KNN
- Discord markup translation (mentions, channels, emojis, timestamps)
- Scheduling with Croner (recurring, one-off, relative time)
- Brave Search API tool
- Server awareness tools (member list, channel history search when permitted)
- Docker compose for dev/prod

## Quick start

```bash
# Copy and fill in secrets
cp .env.example .env

# Development (live reload, debug logging)
bun install
docker compose -f docker-compose.dev.yml up --build

# Production
docker compose up --build -d
```

Dev mounts `src/` and `config/` from the host for live editing. Prod copies source into the image and persists data via Docker volumes (`bot-data`, `model-cache`, `qdrant-data`).

Both profiles start a Qdrant service and wait for it to be healthy before launching the bot.

## Project docs
- `.dev/docs/project-overview.md` for the complete architecture overview
- `.dev/active-missions/` for current execution plans

## License
TBD
