# Architecture

Agentic Discord bot (~9,900 lines TypeScript, 81 files) that embodies a character persona while providing useful responses. Per-guild isolation, long-lived memory, semantic search, scheduling, and multi-tool agent capabilities.

**Runtime:** Bun 1.3+ · **LLM:** OpenRouter (any model) · **Vectors:** Qdrant · **DB:** SQLite (WAL) · **Agent:** pi-agent-core

## Module Map

```
src/
├── index.ts                    Entry point (env validation, logger, startup)
├── logger.ts                   Structured JSON logging with token tracking
├── integration.test.ts         Full pipeline integration tests
│
├── agent/                      Message handling & LLM orchestration
│   ├── handler.ts              Core dispatcher: trigger → prompt → agent → response
│   ├── triggers.ts             Trigger evaluation (mention > keyword > random)
│   ├── prompt.ts               System prompt assembly (persona + context sections)
│   ├── context-trimming.ts     Chat history windowing (trimTrigger/trimTarget, now via SQL LIMIT)
│   ├── send-message-tool.ts    Agent tool: send a message to channel
│   ├── memory-tools.ts         Agent tools: save/delete/list memories (3 tools)
│   ├── search-tool.ts          Agent tool: search chat history (semantic, literal, or ID-based)
│   ├── schedule-tool.ts        Agent tool: relative one-off scheduling
│   ├── member-list-tool.ts     Agent tool: server member roster
│   ├── channel-history-tool.ts Agent tool: fetch recent channel messages
│   ├── brave-search-tool.ts    Agent tool: Brave Search API web search
│   ├── vision.ts               Image resize/format for multimodal input
│
├── commands/                   Admin-only slash commands
│   ├── registry.ts             Global REST registration via discord.js
│   ├── permissions.ts          isAdmin: Discord bitflag + per-guild adminUserIds
│   ├── status.ts               /status — uptime, guild count, stats
│   ├── config.ts               /config list|get|set — per-guild settings
│   ├── schedule.ts             /schedule list|add|remove — cron & one-off
│   └── memory-wipe.ts          /memory-wipe — purge guild data
│
├── config/                     Two-tier configuration (global + per-guild)
│   ├── types.ts                GlobalConfig, GuildConfig, TriggerConfig, TrimConfig
│   └── loader.ts               Env loading, YAML parsing, merge resolution, persistence
│
├── db/                         SQLite data layer
│   ├── database.ts             Schema init (WAL, 3 tables, indexes)
│   ├── memory-repository.ts    CRUD + TTL + scoped listing
│   ├── message-repository.ts   Hybrid Qdrant KNN → SQLite JOIN search
│   └── schedule-repository.ts  CRUD + enabled filtering
│
├── discord/                    Discord.js utilities
│   ├── client.ts               Client creation, intents, login
│   ├── translation.ts          Bidirectional Discord markup ↔ human-readable
│   └── emoji-cache.ts          Per-guild emoji cache with TTL staleness
│
├── embeddings/                 Local embedding model
│   ├── pipeline.ts             bge-m3 via @huggingface/transformers (1024-dim)
│   ├── queue.ts                Batched async queue (32 items / 100ms flush)
│   └── test-utils.ts           Deterministic mock pipeline for tests
│
├── llm/                        LLM provider integration
│   └── client.ts               OpenRouter model resolution, stream options builder
│
├── qdrant/                     Vector database
│   ├── client.ts               Connection, collection setup (cosine, 1024-dim)
│   └── adapter.ts              Point CRUD, search, deterministic ID mapping
│
├── dashboard/                  Request log dashboard (password-protected)
│   ├── store.ts               In-memory ring buffer (1000 entries) for request log entries
│   ├── server.ts              Bun.serve HTTP server with cookie-based auth
│   └── index.html             Single-file dashboard UI (vanilla JS)
│
└── scheduler/                  Job scheduling
    └── engine.ts               Croner (cron) + setTimeout (one-off) orchestration
```

## Core Dataflows

### Message Processing

```
Discord messageCreate event
  │
  ├─ translateInbound(raw, resolvers) → human-readable text
  ├─ Store in SQLite messages table (raw + translated)
  ├─ Enqueue to EmbeddingQueue → batch embed → upsert to Qdrant
  │
  └─ handleMessage(msg, deps)
       │
       ├─ shouldRespond(input, triggers) → mention|keyword|random|null
       │   (returns null → silent; priority: mention > keyword > random)
       │
       ├─ assembleSystemPrompt(ctx)
       │   Sections: persona, emojis, members, journal, schedules, history
       │
       ├─ resolveGuildModel(global, guild) → LlmModel
       │   (guild.model ?? global.defaultModel → pi-ai registry or synthetic fallback)
       │
       ├─ Create Agent (pi-agent-core) with tools:
       │   send_message, save/delete/list_memory, search_messages,
       │   schedule_message, list_members, channel_history, web_search
       │
       └─ agent.prompt(translatedContent, images)
            Agent runs agentic loop, calls tools as needed
            └─ send_message → Discord (reply or normal, with typing)
```

### Message Search (Multi-Mode)

Three search modes via `search_messages` tool:

**Semantic** (`mode: "semantic"`):
```
Query text → pipeline.embed([query]) → Float32Array (1024-dim)
  ↓
searchPoints(qdrant, vector, {guild_id, channel_id?, user_id?, after?, before?})
  ↓
SQLite JOIN: SELECT ... FROM messages WHERE id IN (qdrant_ids)
  ↓
Merged results: translatedContent + authorUsername + relevance_score
```

**Literal** (`mode: "literal"`):
```
Query string
  ↓
SQLite: SELECT ... FROM messages WHERE translated_content LIKE '%query%'
  ↓
Results: matches ordered by recency; guild/channel/user filters applied
```

**ID** (`mode: "id"`):
```
Message ID (snowflake)
  ↓
SQLite: SELECT ... FROM messages WHERE id = ? AND guild_id = ?
  ↓
Result: exact message or null if not found
```

All modes support optional filters: `channel_id`, `user_id`, `after` (epoch ms), `before` (epoch ms).


### Embedding Storage

```
New message or memory
  ↓
queue.enqueue({ id, text, target: "message"|"memory", metadata })
  ↓
Batch accumulates (≥32 items or 100ms timeout)
  ↓
pipeline.embed(texts[]) → Float32Array[]
  ↓
upsertPoints(qdrant, points with payload: {type, entity_id, guild_id, ...})
```

## Database Schema

**SQLite** — WAL mode, foreign keys ON, synchronous NORMAL.

### memories

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| scope | TEXT | `user` · `guild_bot` · `global_bot` · `journal` |
| guild_id | TEXT | nullable; required for user/guild_bot |
| user_id | TEXT | nullable; required for user scope |
| content | TEXT | primary content |
| short_description | TEXT | journal summary |
| long_description | TEXT | journal detail |
| source_message_id | TEXT | originating message ref |
| created_at | INTEGER | epoch ms |
| updated_at | INTEGER | epoch ms |
| expires_at | INTEGER | nullable; 180d default, null for journal |

**Indexes:** `(scope, guild_id, user_id)`, `(expires_at) WHERE expires_at IS NOT NULL`

### messages

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | Discord snowflake |
| guild_id | TEXT | |
| channel_id | TEXT | |
| user_id | TEXT | author |
| author_username | TEXT | for display |
| raw_content | TEXT | Discord markup (`<@id>`) |
| translated_content | TEXT | human-readable (`@username`) |
| is_bot | INTEGER | 0 or 1 |
| created_at | INTEGER | epoch ms |

**Indexes:** `(guild_id, channel_id, created_at)`, `(user_id, guild_id)`

### schedules

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| guild_id | TEXT | |
| channel_id | TEXT | target channel |
| source | TEXT | `admin` · `bot` · `tool` |
| type | TEXT | `cron` · `one_off` |
| cron_expression | TEXT | nullable; for cron type |
| run_at | INTEGER | nullable; epoch ms for one_off |
| timezone | TEXT | default UTC |
| message_content | TEXT | |
| enabled | INTEGER | 0 or 1 |
| created_at | INTEGER | epoch ms |
| updated_at | INTEGER | epoch ms |

**Indexes:** `(guild_id, enabled)`

## Qdrant Collection

- **Name:** `embeddings`
- **Vectors:** 1024 dimensions, cosine distance
- **Payload indexes:** `guild_id` (keyword), `channel_id` (keyword), `user_id` (keyword), `created_at` (integer), `type` (keyword: `"memory"` | `"message"`)
- **Point IDs:** Deterministic UUID v4 derived from entity ID via XOR hash (`toPointId()`)

## Configuration

### Two-tier: Global → Per-Guild

**Global** (environment variables):

| Variable | Required | Default |
|----------|----------|---------|
| `DISCORD_TOKEN` | yes | — |
| `OPENROUTER_API_KEY` | yes | — |
| `BRAVE_API_KEY` | no | — |
| `DEFAULT_MODEL` | no | `moonshotai/kimi-k2.5` |
| `DEFAULT_THINKING_LEVEL` | no | `medium` |
| `DEFAULT_TIMEZONE` | no | `UTC` |
| `MEMORY_RETENTION_DAYS` | no | `180` |
| `IMAGE_MAX_DIMENSION` | no | `768` |
| `PERSONA_PATH` | no | `config/persona.md` |
| `LOG_LEVEL` | no | `info` |
| `DATA_DIR` | no | `data` |
| `MODEL_CACHE_DIR` | no | `model-cache` |
| `QDRANT_URL` | no | `http://localhost:6333` |

**Per-guild** (YAML files in `config/guilds/`):

Filename: `{guildId}-{slug}.yaml` (e.g., `123456-my-server.yaml`). All fields optional — missing values inherit from global defaults via `resolveGuildConfig()`.

Configurable: `model`, `modelParams`, `thinkingLevel`, `timezone`, `triggers` (mention/keywords/randomChance), `trim` (trimTrigger/trimTarget), `memoryRetentionDays`, `adminUserIds`, `imageMaxDimension`.

Hardcoded defaults: `triggers: {mention: true, keywords: [], randomChance: 0}`, `trim: {trimTrigger: 200, trimTarget: 150}`.

## Key Patterns

### Factory + Dependency Injection

All agent tools, command handlers, and infrastructure components use factory functions with injected dependencies. No global state, no singletons (except the embedding pipeline).

```typescript
// Every tool follows this shape
export function createXTool(deps: XToolDeps): AgentTool {
  return {
    name: "tool_name",
    parameters: TypeboxSchema,
    execute: async (_id, params, signal) => {
      // Closure captures deps; guildId auto-scoped
    },
  };
}
```

### Discord Abstraction

Zero direct Discord coupling in agent/tool code. All Discord I/O abstracted via:
- `MessageSender` callback (for sending)
- `InboundResolvers` / `OutboundResolvers` (for mention/channel/role/emoji translation)
- `fetchMembers`, `fetchMessages` callbacks (for guild data)

### Bidirectional Translation

Inbound (Discord → LLM): `<@123>` → `@alice`, `<#456>` → `#general`, `<t:1234:R>` → `"2 days ago"`
Outbound (LLM → Discord): `@alice` → `<@123>`, `#general` → `<#456>`, `:emoji:` → `<:emoji:789>`

Unknown IDs preserved as-is on inbound (no data loss). Failed lookups left as plain text on outbound.

### Dual-Store (SQLite + Qdrant)

- SQLite: source of truth for structured data, metadata, display content
- Qdrant: vector embeddings for semantic KNN search, metadata-filtered
- Search joins both: Qdrant returns IDs + scores → SQLite provides content
- Orphaned Qdrant points silently skipped in results

### Scheduler Engine

Hybrid `croner` (cron with timezone) + `setTimeout` (one-off). Jobs registered dynamically via `addSchedule()`/`removeSchedule()`. One-offs auto-disable after firing. Past one-offs detected and disabled on startup.

## Docker

### Production (`docker-compose.yml`)

- **bot:** multi-stage build (base → deps → prod), `oven/bun:1.3-alpine` + `vips-dev` (sharp). Volumes: `bot-data`, `model-cache`, `./config:ro`. Depends on qdrant healthy.
- **qdrant:** `qdrant/qdrant:latest`, ports 6333/6334, healthcheck via `/healthz`.

### Development (`docker-compose.dev.yml`)

- **bot:** `base` target, `bun --hot`, bind-mounted `src/` + `config/` for live reload, `LOG_LEVEL=debug`.
- Separate volume set (`dev-data`, `dev-model-cache`, `dev-qdrant-data`).

## Dependencies

| Package | Purpose |
|---------|---------|
| `discord.js` ^14.25 | Discord API client |
| `@mariozechner/pi-agent-core` ^0.50 | Agent framework (tool calling, streaming) |
| `@mariozechner/pi-ai` ^0.50 | LLM model registry, message types |
| `@huggingface/transformers` ^3.8 | Local embedding model (bge-m3, 1024-dim) |
| `@qdrant/js-client-rest` ^1.16 | Vector database REST client |
| `@sinclair/typebox` ^0.34 | JSON schema for tool parameters |
| `croner` ^9.1 | Timezone-aware cron scheduling |
| `sharp` ^0.34 | Image processing (resize, format conversion) |
| `yaml` ^2.8 | YAML config parsing |

## Testing

- **Runner:** `bun test`
- **Unit tests:** co-located `.test.ts` files per module
- **Integration tests:** `src/integration.test.ts` (full pipeline)
- **Database tests:** in-memory SQLite (`:memory:`)
- **Qdrant tests:** require running container (`docker run -d --name qdrant-test -p 6333:6333 qdrant/qdrant:latest`), default URL `http://qdrant-test.orb.local:6333`
- **Mock pipeline:** `src/embeddings/test-utils.ts` — deterministic sin-hash embeddings, no model download
- **Quality gate:** `bun run check` (tsc --noEmit + eslint with strict rules: no `any`, no floating promises, no `!` assertions, strict booleans)
