# Architecture

Agentic Discord bot (~16,900 lines TypeScript, 111 files) that embodies a character persona while providing useful responses. Per-guild isolation, long-lived memory, semantic search, scheduling, and multi-tool agent capabilities.

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
│   ├── prompt.ts               System prompt & tool instructions (legacy assembly + TOOL_INSTRUCTIONS export)
│   ├── context-assembly.ts     Structured multi-section context with cache_control metadata
│   ├── context-trimming.ts     Legacy count-based trimming (kept for compat, unused by handler)
│   ├── history-types.ts        HistoryMessage, SliceResult, HistoryProcessingConfig, FormattedLine
│   ├── history-slicing.ts      Deterministic sort + older/newer slice algorithm
│   ├── history-merge.ts        Consecutive plain-message merging by author
│   ├── history-trimming.ts     Whitespace normalization + char-limit trimming with markers
│   ├── history-dates.ts        Deterministic date stamp insertion for older slice
│   ├── history-formatting.ts   Line grammar formatting + OLDER_LEGEND constant
│   ├── history-replies.ts      Reply metadata resolution (quotes, missing targets)
│   ├── reply-target-fallback.ts Discord API fallback for missing reply targets
│   ├── history-pipeline.ts     Pipeline orchestrator: wires all history modules into processHistory()
│   ├── read-images-tool.ts     Agent tool: fetch stored images by ID (base64)
│   ├── send-message-tool.ts    Agent tool: send a message to channel
│   ├── memory-tools.ts         Agent tools: save/delete/list memories (3 tools)
│   ├── search-tool.ts          Agent tool: search chat history (semantic, literal, or ID-based)
│   ├── schedule-tool.ts        Agent tool: relative one-off scheduling
│   ├── member-list-tool.ts     Agent tool: server member roster
│   ├── channel-history-tool.ts Agent tool: fetch recent channel messages
│   ├── brave-search-tool.ts    Agent tool: Brave Search API web search
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
│   ├── database.ts             Schema init (WAL, 4 tables, indexes)
│   ├── memory-repository.ts    CRUD + TTL + scoped listing
│   ├── message-repository.ts   Hybrid Qdrant KNN → SQLite JOIN search
│   ├── schedule-repository.ts  CRUD + enabled filtering
│   ├── image-repository.ts     Image metadata CRUD (insert, query by message/ID)
│   ├── image-storage.ts        Deterministic image path: attachments/{guild}-{channel}/images/{id}.jpg
│   └── image-ingest.ts         Download → resize → JPEG q=85 → persist pipeline
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
       ├─ assembleContext(input) → AssembledContext
       │   Ordered sections with cache_control metadata:
       │   persona → tools → emojis → members → journal → schedules
       │   → older history (cached) → newer history (uncached) → current context
       │   Serialized via contextToSystemPrompt() into single string
       │   (pi-agent-core only supports systemPrompt: string)
       │
       ├─ resolveGuildModel(global, guild) → LlmModel
       │   (guild.model ?? global.defaultModel → pi-ai registry or synthetic fallback)
       │
       ├─ Create Agent (pi-agent-core) with tools:
       │   send_message, save/delete/list_memory, search_messages,
       │   schedule_message, list_members, channel_history, web_search, read_images
       │
       └─ agent.prompt(translatedContent)
            No inline images — LLM uses read_images tool on demand
            Agent runs agentic loop, calls tools as needed
            └─ send_message → Discord (reply or normal, with typing)

Typing indicator behavior is driven by agent events: typing starts on turn/message activity,
pauses before `send_message` to avoid sendTyping/message races, and is suppressed after
the final send until another non-send tool actually begins. This avoids Discord’s
“ghost typing” window after the last message.
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

### Context Assembly

```
buildContext(deps) → AssembledContext
  │
  ├─ Deterministic sorting (emojis, members, journal, schedules)
  ├─ assembleContext({ persona, toolInstructions, instructions, emojis,
  │     members, journalSummaries, upcomingSchedules, olderHistory,
  │     newerHistory, currentContext, userMessage })
  │
  └─ AssembledContext
       ├─ sections[]: ContextSection { label, text, cached }
       └─ userMessage: string (role=user)
```

Sections ordered for Anthropic prefix-based prompt caching: stable cached sections first (persona, tools, instructions, emojis, members, journal, schedules, older history), then uncached (newer history, current context). Empty sections omitted. Currently serialized to a single string via `contextToSystemPrompt()` since `pi-agent-core` only supports `systemPrompt: string`.

### History Processing Pipeline

```
Raw messages from SQLite
  │
  ├─ 1. fetchMissingReplyTargets() — Discord API fallback for missing reply_to_id targets
  ├─ 2. Filter out latest user message ID
  ├─ 3. sortMessages() — timestamp ASC, message ID tie-break
  ├─ 4. mergeConsecutiveMessages() — same author, plain, within gap threshold
  ├─ 5. Detach latest user message
  ├─ 6. sliceHistory() — deterministic older/newer split
  ├─ 7. trimMessages() — normalize whitespace + char limit with markers
  ├─ 8. resolveReplies() — quote embedding based on slice position
  ├─ 9. insertDateStamps() — sparse 5-min interval, older slice only
  └─ 10. formatMessageLine() — deterministic grammar with meta key order
```

All D/E modules are pure functions (except `fetchMissingReplyTargets` which has side effects). History slicing: older = `trimTarget - windowSize` messages (cached, stable), newer = `windowSize` messages (uncached, recent).

### Image Ingest

```
Discord attachment (message event or API fallback)
  │
  ├─ processImageBuffer(buffer) — resize to imageMaxDimension, JPEG q=85
  ├─ insertImage(db, metadata) → autoincrement ID
  ├─ imagePath(attachmentsDir, guildId, channelId, imageId) → deterministic path
  └─ Write to disk: attachments/{guildId}-{channelId}/images/{imageId}.jpg
```

No inline images in LLM context. Messages reference `image_ids`; LLM retrieves via `read_images` tool.

## Database Schema

**SQLite** — WAL mode, foreign keys ON, synchronous NORMAL.

### memories

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| scope | TEXT | `user` · `journal` |
| guild_id | TEXT | required; all memories are per-guild |
| user_id | TEXT | required; for journal scope = bot's own user ID |
| content | TEXT | primary content |
| short_description | TEXT | summary (both scopes) |
| long_description | TEXT | detail (both scopes) |
| source_message_id | TEXT | originating message ref |
| created_at | INTEGER | epoch ms |
| updated_at | INTEGER | epoch ms |
| expires_at | INTEGER | nullable; 180d default for all scopes |

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
| reply_to_id | TEXT | nullable; Discord message ID of replied-to message |

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

### images

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK AUTOINCREMENT | Global unique, never-reused |
| message_id | TEXT | Discord snowflake (owning message) |
| guild_id | TEXT | |
| channel_id | TEXT | |
| caption | TEXT | nullable; TBD captioning model |
| path | TEXT | Disk path (set after write) |
| mime | TEXT | Always `image/jpeg` |
| width | INTEGER | Post-resize |
| height | INTEGER | Post-resize |
| created_at | INTEGER | epoch ms |

**Indexes:** `(message_id)`, `(guild_id, channel_id)`

## Qdrant Collection

- **Name:** `embeddings`
- **Vectors:** 1024 dimensions, cosine distance
- **Payload indexes:** `guild_id` (keyword), `channel_id` (keyword), `user_id` (keyword), `created_at` (integer), `type` (keyword: `"memory"` | `"message"`)
- **Point IDs:** Deterministic UUID v4 derived from entity ID via XOR hash (`toPointId()`)

## Configuration

### Three-tier: Main YAML → Per-Guild YAML → Env Vars (secrets only)

**Main config** (`config/config.yaml`):

All non-secret defaults in a single YAML file. Missing file = hardcoded defaults. See `config/config.yaml.example` for all fields with comments.

Key fields: `model`, `thinkingLevel`, `timezone`, `trim`, `triggers`, `memoryRetentionDays`, `imageMaxDimension`, `mergeMessageGapSeconds`, `imageReadMaxPerCall`, `imageCaptioningEnabled`, `personaPath`, `instructions`, `instructionsPath`, `logLevel`, `dataDir`, `modelCacheDir`, `qdrantUrl`.

**Environment variables** (secrets and infrastructure):

| Variable | Required | Notes |
|----------|----------|-------|
| `DISCORD_TOKEN` | yes | Discord bot token |
| `OPENROUTER_API_KEY` | yes | OpenRouter API key |
| `BRAVE_API_KEY` | no | Brave Search API key |
| `QDRANT_URL` | no | Overrides YAML `qdrantUrl` (infrastructure-dependent) |
| `DASHBOARD_PASSWORD` | no | Dashboard auth |
| `UNSAFELY_BYPASS_DASHBOARD_AUTH` | no | Dev-only dashboard bypass |

**Per-guild** (YAML files in `config/guilds/`):

Filename: `{guildId}-{slug}.yaml` (e.g., `123456-my-server.yaml`). All fields optional — missing values inherit from main config defaults via `resolveGuildConfig()`. See `config/guilds/000000000-example.yaml.example` for all fields.

Configurable: `model`, `modelParams`, `thinkingLevel`, `timezone`, `triggers` (mention/keywords/randomChance), `trim` (trimTrigger/trimTarget/windowSize/messageCharLimit/replyQuoteChars), `memoryRetentionDays`, `adminUserIds`, `imageMaxDimension`, `mergeMessageGapSeconds`, `imageReadMaxPerCall`, `imageCaptioningEnabled`, `attachmentsDir`, `instructions`, `instructionsPath`.

**Instructions**: Custom text injected into LLM context (after tool instructions, before emojis). `instructionsPath` loads from a file; `instructions` provides inline text. `instructionsPath` takes priority. Guild-level overrides global default.

### Hot-Reload

`fs.watch("config", { recursive: true })` watches the entire `config/` directory. Changes debounced at 500ms. On trigger: reloads main config → persona → all guild configs. Malformed YAML or missing files keep last known good config.

Hardcoded defaults: `triggers: {mention: true, keywords: [], randomChance: 0}`, `trim: {trimTrigger: 200, trimTarget: 150, windowSize: 20, messageCharLimit: 200, replyQuoteChars: 50}`, `mergeMessageGapSeconds: 120`, `imageReadMaxPerCall: 10`, `imageCaptioningEnabled: false`, `attachmentsDir: ${dataDir}/attachments`.

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

- **Runner:** `make test`
- **Unit tests:** co-located `.test.ts` files per module
- **Integration tests:** `src/integration.test.ts` (full pipeline), `src/agent/integration-images.test.ts` (image tools + Discord fallback)
- **History processing tests:** 68 tests across 5 files (slicing, merge, trim, dates, formatting) — all deterministic, pure-function tests
- **Reply tests:** 19 tests in `history-replies.test.ts` — position-aware quoting, cross-slice, missing targets, extraLookup
- **Pipeline orchestrator tests:** 8 tests in `history-pipeline.test.ts` — end-to-end formatting, slicing, merge, trim markers, reply metadata
- **Discord fallback tests:** 11 tests in `reply-target-fallback.test.ts` — mocked Discord API, DB persistence, image attachment processing
- **Message repository tests:** 35 tests including 6 for `getHistoryMessages` (shape, images, limit, order)
- **Image tool tests:** 8 unit + 8 integration tests for `read_images` (real SQLite in integration)
- **Database tests:** in-memory SQLite (`:memory:`)
- **Qdrant tests:** require running container (`docker run -d --name qdrant-test -p 6333:6333 qdrant/qdrant:latest`), default URL `http://qdrant-test.orb.local:6333`
- **Mock pipeline:** `src/embeddings/test-utils.ts` — deterministic sin-hash embeddings, no model download
- **Quality gate:** `bun run check` (tsc --noEmit + eslint with strict rules: no `any`, no floating promises, no `!` assertions, strict booleans)
