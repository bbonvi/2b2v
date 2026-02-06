# Architecture

Agentic Discord bot (~16,900 lines TypeScript, 111 files) that embodies a character persona while providing useful responses. Per-guild isolation, long-lived memory, semantic search, scheduling, and multi-tool agent capabilities.

**Runtime:** Bun 1.3+ · **LLM:** OpenRouter (any model) · **Vectors:** Qdrant · **DB:** SQLite (WAL) · **Agent:** pi-agent-core

## Module Map

```
src/
├── index.ts          Entry point, runtime wiring
├── agent/            Context assembly, history pipeline, agent tools
├── commands/         Slash command handlers
├── config/           Config types + loader
├── db/               SQLite repositories, image storage
├── discord/          Discord client helpers, translation
├── embeddings/       Embedding pipeline + queue
├── llm/              OpenRouter client
├── qdrant/           Vector store adapter
├── scheduler/        Cron and one-off scheduling
├── time/             Centralized agent-facing time utilities
├── tts/              Voice message integration
└── dashboard/        Request log dashboard
```

## Core Dataflows

### Message Processing

```
Discord messageCreate event
  │
  ├─ translateInbound(raw, resolvers) → human-readable text
  ├─ Store in SQLite messages table (raw + translated)
  ├─ Enqueue embeddings → batch embed → upsert to Qdrant
  │
  └─ handleMessage(msg, deps)
       ├─ shouldRespond(input, triggers) → mention|keyword|random|null
       ├─ build context (persona, instructions, emojis, members, journal, schedules, history, current context)
       ├─ resolve model (guild overrides global default)
       └─ agent prompt with tools:
          messaging + threading (`send_message`, `start_thread`), memory, search,
          scheduling, member + chat history, web + URL fetch, image read/fetch
```

### Message Search

`search_messages` supports:
- Semantic search via Qdrant KNN with metadata filters, then SQLite join for display content
- Literal search via SQLite `LIKE` on translated content
- ID lookup for exact message retrieval

Filters: `channel_id`, `user_id`, `after`, `before` (epoch ms).

### Embedding Storage

Messages and memories enqueue into a batcher, get embedded by the local model, and are upserted into Qdrant with guild-scoped payload metadata.

### Context Assembly

Context is assembled into ordered sections (persona, instructions, emojis, members, journal, schedules, history, current context) and serialized for the agent.

### History Processing

Pipeline: fetch missing reply targets (Discord fallback), sort, merge consecutive author messages, slice older and newer windows, trim, resolve replies, insert sparse date stamps, then format lines.

### Image Ingest

Attachments are resized, stored, and referenced by ID. The agent retrieves images on demand from storage, external URLs are fetched ephemerally.

## Qdrant Collection

- **Name:** `embeddings`
- **Vectors:** 1024 dimensions, cosine distance
- **Payload indexes:** `guild_id` (keyword), `channel_id` (keyword), `user_id` (keyword), `created_at` (integer), `type` (keyword: `"memory"` | `"message"`)
- **Point IDs:** Deterministic UUID v4 derived from entity ID via XOR hash (`toPointId()`)

## Configuration

Three-tier config:
- Main config: `config/config.yaml` for non-secret defaults (optional). See `config/config.yaml.example` for the full list.
- Per-guild config: `config/guilds/{guildId}-{slug}.yaml` overrides main defaults.
- Environment variables: secrets and infrastructure overrides.

**Environment variables**:

| Variable | Required | Notes |
|----------|----------|-------|
| `DISCORD_TOKEN` | yes | Discord bot token |
| `OPENROUTER_API_KEY` | yes | OpenRouter API key |
| `BRAVE_API_KEY` | no | Brave Search API key |
| `QDRANT_URL` | no | Overrides YAML `qdrantUrl` (infrastructure-dependent) |
| `DASHBOARD_PASSWORD` | no | Dashboard auth |
| `UNSAFELY_BYPASS_DASHBOARD_AUTH` | no | Dev-only dashboard bypass |
| `ELEVENLABS_API_KEY` | no | ElevenLabs API key for voice message generation |

**Per-guild overrides**:

Filename: `{guildId}-{slug}.yaml` (e.g., `123456-my-server.yaml`). All fields optional, missing values inherit from main defaults. See `config/guilds/000000000-example.yaml.example` for the full list.

**Instructions**: Custom text injected into LLM context (after tool instructions, before emojis). `instructionsPath` loads from a file; `instructions` provides inline text. `instructionsPath` takes priority. Guild-level overrides global default.

### Hot-Reload

`fs.watch("config", { recursive: true })` watches the entire `config/` directory. Changes are debounced and reload the main config, persona, and all guild configs. Malformed YAML or missing files keep the last known good config.

## Key Patterns

### Factory + Dependency Injection

Agent tools, command handlers, and infrastructure components use factories with injected dependencies. This keeps core logic testable and avoids global state (except the embedding pipeline).

### Discord Abstraction

Agent and tool code does not depend on Discord.js directly. Discord I/O is abstracted through callbacks for sending, translation, and member/message fetches.

### Bidirectional Translation

Inbound Discord markup is translated to human-readable text, outbound content is translated back. Unknown IDs are preserved, failed lookups fall back to plain text.

### Dual-Store (SQLite + Qdrant)

SQLite is the source of truth for structured data and display content. Qdrant stores embeddings. Search joins Qdrant results back to SQLite, orphaned points are skipped.

### Time Contract

All agent-facing timestamps use local wall-clock time in the guild's configured timezone. No ISO `Z` strings appear in prompts, tool outputs, or context sections.

- **Internal representation:** epoch milliseconds for determinism.
- **Agent-visible format:** `YYYY-MM-DD HH:mm` (no offset, timezone communicated once in the Current Context block).
- **Centralized module:** `src/time/agent-time.ts` provides `formatLocalWallClock()`, `currentLocalContext()`, and `parseLocalDateTimeToEpoch()`.
- **DST safety:** Parsing uses Temporal polyfill with `disambiguation: 'reject'`. Nonexistent and ambiguous local times are rejected with actionable errors.
- **One-off scheduling:** `schedule_message` tool supports `mode: "at"` with local datetime and `mode: "in"` with relative delay. `/schedule add one_off` accepts only `YYYY-MM-DD HH:mm` in guild timezone.
- **Cron scheduling:** Timezone defaults to guild timezone, explicit override still allowed.

### Scheduler Engine

Hybrid `croner` (cron with timezone) + `setTimeout` (one-off). Jobs registered dynamically via `addSchedule()`/`removeSchedule()`. One-offs auto-disable after firing. Past one-offs detected and disabled on startup.

## Docker

Two Compose files:
- `docker-compose.yml` for production builds and long-lived volumes, bot waits on Qdrant health.
- `docker-compose.dev.yml` for live reload with bind mounts and separate dev volumes.
