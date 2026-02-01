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
- Memory system with SQLite + sqlite-vec (user, guild, global, journal)
- Semantic search over translated message history with filters
- Discord markup translation (mentions, channels, emojis, timestamps)
- Scheduling with Croner (recurring, one-off, relative time)
- Brave Search API tool
- Server awareness tools (member list, channel history search when permitted)
- Docker compose for dev/prod

## Project docs
- `.dev/docs/project-overview.md` for the complete architecture overview
- `.dev/active-missions/` for current execution plans

## License
TBD
