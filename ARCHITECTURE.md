# Architecture

Personal Discord bot for small servers. The runtime is intentionally simple: one persona model call handles the reply, uses native OpenRouter tool calls when needed, and sends final text directly to Discord.

**Runtime:** Bun 1.3+ · **LLM:** OpenRouter · **Vectors:** Qdrant · **DB:** SQLite (WAL) · **Agent:** native tool-calling reply loop (`src/agent/handler.ts`)

## Module Map

```
src/
├── index.ts          Entry point, Discord wiring, tool wiring, background jobs
├── agent/            Context assembly, reply handler, history pipeline, tools
├── commands/         Slash command handlers
├── config/           YAML config types + loader
├── db/               SQLite repositories and schema
├── discord/          Discord client helpers and markup translation
├── embeddings/       Message embedding queue
├── llm/              OpenRouter client
├── qdrant/           Vector store adapter
├── scheduler/        Cron and one-off scheduled messages
├── time/             Guild-local time formatting/parsing
├── tts/              Voice message integration
└── dashboard/        Request log dashboard
```

## Core Dataflow

```
Discord messageCreate
  ├─ translateInbound(raw, resolvers)
  ├─ store message in SQLite
  ├─ enqueue message embedding for Qdrant
  └─ channelDispatcher.enqueue(message, isMention)
       ├─ debounce per channel
       ├─ serialize one handler run per channel
       └─ handleMessage(messages, deps)
            ├─ shouldRespond(mention | keyword | random | forced schedule)
            ├─ assemble prompt context
            ├─ start Discord typing immediately
            ├─ call OpenRouter with native tools
            ├─ execute requested tool calls
            ├─ send final assistant text to Discord
            └─ run background memory extraction
```

`src/discord/channel-dispatcher.ts` owns debounce and channel-level serialization. Mention triggers use a shorter debounce than keyword/random triggers. Messages that arrive while a handler is running wait for the next cycle; there is no mid-loop follow-up injection.

## Reply Runtime

`src/agent/handler.ts` is the single reply control plane.

- The model speaks directly as the persona. There is no orchestrator/persona split and no custom JSON action protocol.
- OpenRouter native `tools` are used for search, schedules, member lookup, chat history, images, URLs, and thread creation.
- Ordinary chat should answer directly without tools.
- Tool results are appended as `role: "tool"` messages, then the model produces final assistant text.
- `start_thread` is special only in routing: after the tool creates a thread, the final answer is sent in that thread.
- The handler enforces `replyLoop.maxToolCalls`, `replyLoop.wallClockTimeoutMs`, and `replyLoop.llmOutputTimeoutMs`.
- The runtime starts typing as soon as a trigger is accepted and stops typing when the handler exits. There is no typing tool.
- The bash tool implementation remains in `src/agent/bash-tool.ts`, but it is not registered in the chat tool list.
- Final text is parsed for reserved app directives in `src/agent/response-directives.ts`: `<voice>` and `<voice type="whisper">` become TTS sends, while `<ignore>` suppresses all Discord output for that run.
- Reserved directive parsing is deliberately narrow: ordinary XML passes through, fenced blocks are unwrapped only when they contain reserved tags, nested voice tags are split, unclosed voice tags consume to EOF, unmatched closing tags stay as text, and TTS failures fall back to plain text.

## Context Assembly

`src/agent/context-assembly.ts` defines prompt section order, role, cache behavior, and headers. Empty sections are omitted.

Cached stable sections:
- persona prompt (`prompts/persona.md`)
- style prompt (`prompts/style.md`, through `promptProfile.lateInstructions`)
- stable guild/server context such as emojis and tool-independent instructions

Uncached volatile sections:
- current time/context
- members
- schedules
- direct memories
- older and recent history
- current user messages
- trigger-specific response instruction

Prompt caching is applied as one cache breakpoint on the merged stable prefix when `promptCaching.enabled` is true. Memory and history stay uncached so they can change without invalidating the stable prefix.

## Memory

Memory is plain SQLite data, not a chat-visible tool.

- `src/db/memory-repository.ts` stores structured rows: `guild_id`, optional `subject_user_id`, `kind`, `content`, `source_message_id`, `confidence`, timestamps, and soft-delete state.
- `src/agent/memory-service.ts` injects active global memories plus current-user memories directly into the `## Memory` context block.
- After a successful reply, a background extraction call updates memories with strict JSON schema output.
- Memory kinds are `global_note`, `user_note`, `preference`, `relationship`, `project`, and `fact`.
- `/memory-wipe` clears guild memory and message history.

The member list includes per-user memory counts, so the model can tell when another user has stored context even though only current-user/global memories are injected by default.

## History And Search

The prompt carries two local history windows for cache efficiency:
- an older trimmed window for broader context
- a recent window for the latest conversation state

`search_messages` remains available for older recall. It supports semantic Qdrant search, literal SQLite search, and exact message ID lookup with filters for channel, user, and time.

The history pipeline fetches missing reply targets when possible, sorts messages, merges consecutive messages by author, trims content, resolves replies, inserts sparse date stamps, and formats the result for the prompt.

## Tools

Default chat tools are wired in `src/index.ts`:
- `search_messages`
- `schedule_message`
- `member_list`
- `chat_history`
- `read_chat_images`
- `fetch_images`
- `fetch_url`
- `web_search` when `BRAVE_API_KEY` is configured
- `start_thread` for normal message-triggered runs

Scheduled runs use the same core tool set but are forced triggers. Users can create and manage scheduled messages themselves through the `schedule_message` tool; slash commands still exist for admin inspection and manual management.

## Images

Inbound image attachments are resized, stored on disk, indexed in SQLite, and linked to their source messages. `read_chat_images` lets the model inspect stored images by message/image context. `fetch_images` retrieves external image URLs ephemerally.

## Storage

SQLite tables:
- `messages`: raw and translated Discord messages, reply targets, synthetic/thread metadata
- `memories`: direct persistent memories
- `schedules`: cron and one-off scheduled messages
- `images`: stored image metadata
- `threads`: Discord thread metadata

Qdrant collection:
- **Name:** `embeddings`
- **Vectors:** 1024 dimensions, cosine distance
- **Payload indexes:** `guild_id`, `channel_id`, `user_id`, `created_at`, `type`
- **Active app use:** message embeddings for `search_messages`

SQLite is the source of truth for display content. Qdrant stores vectors and payload metadata; search joins vector results back to SQLite rows.

## Configuration

Three-tier config:
- `config/config.yaml` for global non-secret defaults
- `config/guilds/{guildId}-{slug}.yaml` for guild overrides
- environment variables for secrets and infrastructure

Important environment variables:

| Variable | Required | Notes |
|----------|----------|-------|
| `DISCORD_TOKEN` | yes | Discord bot token |
| `OPENROUTER_API_KEY` | yes | OpenRouter API key |
| `BRAVE_API_KEY` | no | Enables web search |
| `QDRANT_URL` | no | Overrides YAML Qdrant URL |
| `DASHBOARD_PASSWORD` | no | Dashboard auth |
| `UNSAFELY_BYPASS_DASHBOARD_AUTH` | no | Dev-only dashboard bypass |
| `ELEVENLABS_API_KEY` | no | Voice message generation |

Key config groups:
- `dispatcher`: channel debounce and serialization
- `promptCaching`: stable prompt cache breakpoint control
- `replyLoop`: native tool-calling reply limits
- `promptProfile`: prompt source selection for persona, optional tool instructions, optional extra instructions, and style rules

Default prompt sources:
- `persona`: `prompts/persona.md`
- `toolInstructions`: empty
- `instructions`: empty
- `lateInstructions`: `prompts/style.md`

When adding or removing config fields, update:
- `config/config.yaml.example`
- `config/guilds/000000000-example.yaml.example`
- `src/config/types.ts`
- `src/config/loader.ts`
- loader tests
- README and this document

## Key Contracts

- Discord-specific APIs stay outside agent/tool logic behind injected callbacks.
- Inbound Discord markup is translated to readable text; outbound content is translated back.
- Agent-facing timestamps use guild-local wall-clock time: `YYYY-MM-DD HH:mm`, with timezone communicated in context.
- One-off schedules support absolute local time or relative delay. Cron schedules use the guild timezone unless explicitly overridden.
- Request/response payloads are recorded in the dashboard log with large image fields truncated for readability.

## Docker

Two Compose files:
- `docker-compose.yml` for production builds and long-lived volumes
- `docker-compose.dev.yml` for live reload with bind mounts and dev volumes

The production bot waits on Qdrant health before startup.
