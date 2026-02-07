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
  └─ channelDispatcher.enqueue(msg, isMention)
       │
       ├─ debounce (mention: 500ms, default: 2000ms)
       ├─ serialize: one handler execution per channel at a time
       │
       └─ handleMessage(msgs, deps)
            ├─ shouldRespond(input, triggers) → mention|keyword|random|null
            ├─ build context (persona, instructions, emojis, members, journal, schedules, history, current context)
            ├─ resolve model (guild overrides global default)
            └─ agent prompt with tools:
               messaging + threading (`send_message`, `start_thread`), memory, search,
               scheduling, member + chat history, web + URL fetch, image read/fetch
```

### Channel Dispatcher

`src/discord/channel-dispatcher.ts` -- per-channel debounce and serialized handler execution. Created via `createChannelDispatcher({ config, handler })`.

**Debounce:** When messages arrive, the dispatcher waits for a configurable quiet period before invoking the handler. Mention triggers use a shorter debounce (`mentionDebounceMs`, default 500ms) than keyword/random triggers (`defaultDebounceMs`, default 2000ms). If a mention arrives while a non-mention timer is running, the timer is shortened.

**Serialization:** Only one handler execution runs per channel at a time. Messages that arrive during handler execution are queued and dispatched in a new debounce cycle after the current handler completes.

**Lifecycle:** `enqueue(message, isMention)` is the only entry point from `messageCreate`. `dispose()` clears all timers and state.

### Message Search

`search_messages` supports:
- Semantic search via Qdrant KNN with metadata filters, then SQLite join for display content
- Literal search via SQLite `LIKE` on translated content
- ID lookup for exact message retrieval

Filters: `channel_id`, `user_id`, `after`, `before` (epoch ms).

### Embedding Storage

Messages and memories enqueue into a batcher, get embedded by the local model, and are upserted into Qdrant with guild-scoped payload metadata.

### Context Assembly

`SECTION_DEFS` in `src/agent/context-assembly.ts` is the single source of truth for section order, labels, roles, caching, and headers. Array position determines output order. Sections are grouped into three message blocks for prefix caching:
- **Group 1** (system, cached): Tool Instructions, Persona, Instructions
- **Group 2** (developer, cached): Emojis, Members, Thread Metadata, Parent Pre-Context, Older History
- **Group 3** (developer, uncached): Threads, Schedules, Journal, Newer History, Current Context, Late Instruction

Empty sections are omitted. `assembleContext()` iterates the registry; no imperative per-section logic.

For OpenRouter Anthropic models, `handleMessage()` rewrites outbound OpenAI-compatible payloads so Group 1 and Group 2 are inserted as multipart text blocks with `cache_control: { type: "ephemeral" }`. Any cache markers on volatile conversation messages are stripped first. This places cache breakpoints only on stable prefix blocks.

### History Processing

Pipeline: fetch missing reply targets (Discord fallback), sort, merge consecutive author messages, slice older and newer windows, trim, resolve replies, insert sparse date stamps, then format lines.

### Mid-Loop Follow-Up Awareness

When the dispatcher is enabled, the agent gains awareness of new channel messages that arrive during its multi-turn processing loop. Two complementary mechanisms handle this.

**Tool follow-up wrapper** (`src/agent/tool-followup-wrapper.ts`): Wraps all agent tools to append follow-up annotations to tool results. After each tool execution, queries SQLite for new messages (via `getFollowUpMessages`). For `send_message`, appends detailed annotations with author, message ID, relative timestamp, and content. For other tools, appends a lightweight count notification suggesting the agent use `chat_history` to review. Tracks surfaced message IDs to avoid re-surfacing. Applied in the tool pipeline after `wrapToolsWithTiming`:

```
tools -> patchToolLookup -> wrapToolsWithTiming -> wrapToolsWithFollowUp -> Agent
```

**`transformContext`**: Mid-loop context injection callback passed to the pi-agent-core `Agent`. Called before each LLM turn, it queries for follow-up messages and injects them as a `[CHANNEL UPDATE]` developer message into the conversation. Only surfaces user messages (not bot). Caps surfaced count at the trim window size to avoid context bloat. Works alongside the tool wrapper: `transformContext` handles inter-turn awareness, the tool wrapper handles intra-turn awareness.

**`reply_to_message_id`**: Optional parameter on `send_message` that lets the agent reply to a specific message by Discord message ID. When set, the `reply` boolean is ignored and the message is sent as a reply to the target. Enables the agent to address specific follow-up messages rather than only the original trigger.

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

**Dispatcher config** (`DispatcherConfig`): Controls channel dispatcher behavior. Nested under `dispatcher` in guild config, `defaultDispatcher` in global config.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `enabled` | boolean | `true` | Enable/disable per-channel debounce and serialization |
| `mentionDebounceMs` | number | `500` | Debounce delay for mention triggers |
| `defaultDebounceMs` | number | `2000` | Debounce delay for keyword/random triggers |
| `maxFollowUps` | number | `5` | Max follow-up messages surfaced per tool check |

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

### Follow-Up Repository

`src/db/followup-repository.ts` -- lightweight SQLite query for messages that arrived in a channel after a given timestamp. Filters out synthetic messages and a set of excluded IDs (bot's own sends, trigger message). Returns `FollowUpMessage[]` with content, author, mention status. Used by the tool follow-up wrapper and `transformContext` injection to detect new activity during agent processing.

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
