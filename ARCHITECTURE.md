# Architecture

This file records invariants that are easy to break and not obvious from file names. Prefer code and tests for ordinary module maps, option lists, and implementation inventory.

## Reply Loop

`src/agent/handler.ts` is the reply control plane. The persona model speaks directly; there is no hidden orchestrator model and no custom JSON action protocol.

Tool results are appended as `role: "tool"` messages, then the same model produces final text. Read-only tools may run concurrently only when they are in the same model turn and on the allowlist. State-changing or unknown tools remain ordered execution barriers.

`start_thread` changes only final-answer routing: after the tool creates a thread, the assistant's final answer is sent there.

Tool-budget exhaustion is recoverable. Pending tool calls get synthetic results, then the model gets one final no-tools turn to answer from available context.

Typing is runtime-owned. The model has no typing tool.

`fetch_url` races Jina Reader against `@steipete/summarize-core`; if summarize-core fails, that same branch falls back to the local Readability/Turndown extractor. Anti-bot challenge pages are failures, not returned content.

`summarize_video` uses `@steipete/summarize-core` with a longer timeout for YouTube, direct media, and podcast transcript extraction. It returns extracted transcript/content as tool context; the reply model still writes the user-facing summary.

## Prompt Cache

Prompt caching depends on stable content staying stable. OpenRouter receives one merged stable prefix with cache breakpoints plus a tiny stable user/assistant anchor before volatile turn context. The Codex subscription backend receives the stable prefix as the pi-ai system prompt because the Codex Responses adapter owns payload construction.

LLM requests include a deterministic `session_id` scoped to guild, channel, provider, and model so provider sticky routing can keep the same cache-warmed endpoint across tool turns and later reply loops. OpenRouter request logs preserve `prompt_tokens_details.cached_tokens` and `cache_write_tokens` for verification.

Dynamic sections such as current time, current channel state, pending schedule summary, memories, recent history, current user messages, and trigger instructions must stay after the anchor.

Older chat history moves only in `trim.windowSize` chunks. Do not promote one message at a time from recent history to older cached history.

`ReplyMsgID` is resolved internally for quote and image context, but is intentionally hidden from normal prompt history until direct replies are explicitly supported.

Merged history rows must preserve all component Discord message IDs. Reply resolution and prompt-visible search exclusions must treat aliases as present, not only the retained first ID.

## History, Search, Memory

SQLite is the source of truth for readable state. Qdrant is only a semantic index; search results must join back to SQLite rows.

Message vectors use `normalizeMessageForEmbedding`: Discord markup and URLs are reduced to searchable placeholders, but ordinary short text such as "ok" or "lol" is preserved. Usernames, channel IDs, timestamps, bot/human state, vector source, and vector granularity belong in Qdrant payload fields, not embedded text.

Backfill and reindex jobs merge consecutive same-author messages into vector blocks. Search resolves merged payload message IDs back to SQLite rows and returns one chronological excerpt.

`search_messages` excludes messages already visible in prompt history. Semantic search overfetches before this filtering so small result limits do not go empty just because top hits are already in context.

Search defaults to the current channel/thread/DM and omits repeated `chat_id` tags for scoped results. A provided `chat_id` scopes search to that specific chat. Results expose message IDs as anchors; the same tool can fetch chronological context around a message ID or around a local timestamp.

`search_messages` is text-first. Discord attachment metadata is opt-in via `include_attachments` because uncached historical messages require per-message Discord API fetches.

Memory is direct SQLite data, not a chat-visible tool. The prompt gets global memories plus current-user memories; other users' stored context is signaled only indirectly, such as through member memory counts.

## Schedules

Agent schedule tools are current-guild and current-channel scoped, and list/delete only pending schedules. Prompt context exposes only a pending count summary; IDs and details require `list_scheduled_messages`.

Slash commands are the broader admin surface for guild schedule inspection and manual management.

One-off timers longer than 2,147,483,647 ms must be chunked and re-armed because JavaScript timers cannot represent longer delays safely.

## Images And Voice

Image tool results become multimodal model input according to provider metadata. OpenRouter support is refreshed from `/api/v1/models?output_modalities=all`; Codex support comes from the pi-ai model registry. If metadata says the selected main model lacks `image` input, text-only models receive tool text or, when enabled, a fallback vision-model description; if metadata is unavailable, the agent tries native image input first and only falls back after an endpoint rejection.

Response directive parsing is deliberately narrow. `<voice>` sends audio, `<ignore>` suppresses output, and other XML remains normal text. Do not add broad XML parsing.

ElevenLabs v3 bracket delivery tags inside `<voice>` are prompt policy, not code policy. Do not filter them in code.

## Config Changes

When adding or removing config fields, update the example config files, config types, loader logic, loader tests, README reference text, and any invariant in this file affected by the change.

## Maintenance Scripts

`scripts/import-legacy-channel-history.ts` streams older Discord channel messages into SQLite and Qdrant. It starts before the oldest stored message for that guild/channel and skips existing message IDs.

`scripts/reindex-message-vectors.ts` is the repair path for garbage or stale message vectors. Dry-run counts source messages and merged blocks; `--apply` deletes matching message vectors and rebuilds them from SQLite with the current normalizer and payload schema.
