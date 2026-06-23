# Architecture

This file records maintainer invariants that are easy to break and not obvious from file names, types, or tests. Keep setup, commands, and config reference material in `README.md`; keep ordinary implementation inventory in code.

Good entries explain a durable constraint, a cross-module data contract, or a product/security boundary. If an entry only says which file implements something, what options exist, or how to run a script, prefer deleting it.

## Reply Loop

`src/agent/handler.ts` is the reply control plane. The persona model speaks directly; there is no hidden orchestrator model and no custom JSON action protocol.

Tool results are appended as `role: "tool"` messages, then the same model produces final text. Read-only tools may run concurrently only when they are in the same model turn and on the allowlist. State-changing or unknown tools remain ordered execution barriers.

Codex Responses reasoning continuity is internal reply-loop state. Assistant turns from the Codex adapter may carry provider-native thinking blocks with encrypted reasoning signatures; keep those blocks with the matching native tool call IDs until the next Codex request after tool results, but never render them into Discord-visible output or persisted prompt-history text.

Dashboard request logs are grouped by model request. Token usage, cache read/write, cache discount, and cost belong to the model request that produced them; emitted tool calls are linked back to that model request by tool-call ID. Parallel read-only tools share a dashboard tool batch, while ordered/state-changing calls are separate batches. Active request snapshots are in-memory only and are replaced by the terminal ring-buffer entry when the request emits.

`react_to_message` is a state-changing acknowledgement tool. It may only target visible or retrievable messages in accessible guild text channels/threads; DMs and inaccessible channels are rejected by the Discord channel resolver. When a reaction fully handles the turn, the final assistant output should be `<ignore>` so the bot behaves like a normal chat user instead of sending redundant text.

`start_thread` and `close_thread` manage thread state only. They must not mutate hidden delivery routing for later final answers, intermediate status, typing, ignored-reply persistence, or async image jobs. To send to a created thread, the model must use an explicit `<message channel_id="...">` directive.

Per-message `<message channel_id="...">` delivery can route individual output messages to any accessible guild channel or thread, including another guild. DMs are out of scope and rejected by the Discord channel resolver. Cross-guild channel reads are deliberately limited to accessible guild channels discovered through Discord context or `list_channels`: `chat_history` and `search_messages` may read another guild by channel ID, while image ID reads remain current-guild unless the tool explicitly validates broader access. For cross-guild sends, sent bot messages and generated/bot image attachments are stored under the target guild/channel, while source request metadata remains tied to the originating guild/channel. Bot messages sent from another channel context also keep `routed_from_*` source IDs; when a later user replies to one, the current-turn metadata tells the model it previously sent that message from another channel and points it at the source channel/message for tool lookup.

`edit_own_message` and `delete_own_message` must authorize against the live Discord message before mutating anything. They may only touch messages authored by the current bot user in accessible guild text channels/threads; user-authored messages and DMs are rejected. Local SQLite and Qdrant state are updated after the Discord mutation, and vector cleanup must remove merged message blocks that reference the edited/deleted message ID.

Tool-budget exhaustion is recoverable. Pending tool calls get synthetic results, then the model gets one final no-tools turn to answer from available context.

Typing is runtime-owned. The model has no typing tool.

Channel dispatch batches preserve the causal reply target and run triggering messages in chronological dispatch units. Mention and keyword triggers may process same-author follow-up text until the next triggering message; random triggers process the actual triggering message. Unrelated later chatter must not inherit another message's trigger reason, and later triggers in the same accumulated batch must remain pending for their own run.

When a long-running handler finishes, queued messages and still-pending debounce messages must be merged into the next batch; promotion must not replace one bucket with the other.

`fetch_url` races Jina Reader against `@steipete/summarize-core`; if summarize-core fails, that same branch falls back to the local Readability/Turndown extractor. Anti-bot challenge pages are failures, not returned content.

`summarize_video` uses `@steipete/summarize-core` with a longer timeout for YouTube, direct media, and podcast transcript extraction. It returns extracted transcript/content as tool context; the reply model still writes the user-facing summary.

## Prompt Cache

Prompt caching depends on stable content staying stable. OpenRouter receives stable prompt groups before a tiny stable user/assistant anchor and volatile turn context. Codex receives the same stable sequence as prepended Responses `input` messages by default, with only sections configured for the `instructions` target kept in top-level instructions. Keep the stable order as core persona/style, compact skills index plus runtime, stable optional context, then older cached history; volatile turn context and the current Discord turn must stay after that stable prefix.

`promptTransport` controls provider-specific role/target placement for logical sections: `core`, `skills`, `runtime`, `stableContext`, `olderHistory`, `serverMembers`, `threadsInChannel`, `discordContext`, `upcomingSchedules`, `memories`, `recentHistory`, `currentContext`, `responseInstruction`, and `currentTurn`. Defaults put core/skills/runtime/responseInstruction in the `developer` role and context/history/current-turn data in the `user` role. Codex supports `mode: split-input` and `mode: legacy-instructions`; `split-input` keeps stable groups separate in the raw Codex payload, while `legacy-instructions` joins stable text into one instruction string. Volatile input messages are ordered as Discord context, upcoming schedules, memory, recent chat history, server members, threads, current context, response instruction, then the current turn. Keep transport config deterministic and avoid placing volatile sections before stable cached sections.

Stable persona/style prompt content is loaded from `prompts/core/**/*.md` in deterministic recursive path order. Use numeric file or directory prefixes when order matters, and keep file names/content stable because this text lives in the cached prompt prefix. Runtime instructions are loaded separately from `prompts/runtime/`: normal reply runtime files come from `reply/**`, silent memory pass control text from `memory/pass/**`, memory-selection policy from `memory/policy/**`, memory context snippets from `memory/context/**`, tool descriptions from `tools/*.md`, tool parameter descriptions from `tool-parameters/<tool>/<param>.md`, volatile context templates from `context/*.md`, and fallback vision instructions from `image-reading/fallback-system/**`. On-demand skills are manifest-backed directories under `prompts/skills/<id>/`; the stable prompt includes only the generated skill index, while loaded skill bodies enter as `load_skill` tool results. Do not let runtime files leak into the core persona/style prompt bundle.

Prompt files are rendered with guaranteed headings before they enter prompts. Source paths stay in loader metadata and logs, not prompt text. Runtime text maps are loaded by deterministic path keys and may use scalar `{{variable}}` placeholders rendered from explicit code-owned values; missing variables are errors, and runtime template output must not depend on filesystem order, clocks, random values, or object iteration. Skill manifests declare instruction file order explicitly; never infer skill body order from filesystem traversal. Changing prompt file text intentionally invalidates provider caches once; nondeterministic file ordering or volatile data in these files would invalidate caches repeatedly and should be treated as a bug.

LLM requests include a deterministic `session_id` scoped to guild, channel, provider, and model so provider sticky routing can keep the same cache-warmed endpoint across tool turns and later reply loops. OpenRouter request logs preserve `prompt_tokens_details.cached_tokens` and `cache_write_tokens` for verification.

Dynamic sections such as current time, current channel state, pending schedule summary, memories, recent history, current user messages, and trigger instructions must stay after the stable prefix/anchor.

Older chat history moves only in `trim.windowSize` chunks. Do not promote one message at a time from recent history to older cached history.

Recent uncached history may show current Discord display names next to usernames for social context. Keep those volatile names out of older cached history because users change them frequently and may use temporary joke/mood labels.

Discord reaction counts are durable SQLite message metadata, but prompt formatting exposes them only in recent uncached history so normal feedback is visible without invalidating older cached context.

`ReplyMsgID` is resolved internally for quote and image context, but is intentionally hidden from normal prompt history until direct replies are explicitly supported.

Merged history rows must preserve all component Discord message IDs. Reply resolution and prompt-visible search exclusions must treat aliases as present, not only the retained first ID.

## History, Search, Memory

SQLite is the source of truth for readable state. Qdrant is only a semantic index; search results must join back to SQLite rows.

Message vectors use `normalizeMessageForEmbedding`: Discord markup and URLs are reduced to searchable placeholders, but ordinary short text such as "ok" or "lol" is preserved. Usernames, channel IDs, timestamps, bot/human state, vector source, and vector granularity belong in Qdrant payload fields, not embedded text.

Backfill and reindex jobs merge consecutive same-author messages into vector blocks. Search resolves merged payload message IDs back to SQLite rows and returns one chronological excerpt.

`search_messages` excludes messages already visible in prompt history. Semantic search overfetches before this filtering so small result limits do not go empty just because top hits are already in context.

Search defaults to the current channel/thread/DM and omits repeated `channel_id` tags for scoped results. A provided `channel_id` scopes search to that specific accessible channel/thread, including another guild; a provided `guild_id` without `channel_id` searches that guild more broadly. Results expose message IDs as anchors; the same tool can fetch chronological context around a message ID or around a local timestamp.

`search_messages` is text-first. Discord attachment metadata is opt-in via `include_attachments` because uncached historical messages require per-message Discord API fetches.

Memory is direct SQLite data by default. Rows have `scope` `guild`, `user`, or `self`: guild memories stay scoped to one guild, user memories are keyed by Discord user ID and follow that user across guilds, and self memories are the bot/persona's own portable continuity and private journal. The prompt gets active current-guild memories, active current-speaker user memories, and capped self memories, with temporary expiries rendered relatively. Memory text should avoid raw guild IDs and use natural local context only when it is essential. Memory kinds are constrained to notes, preferences, relationships, facts, identity, constraints, interests, journal, and scratchpad. Scratchpad is short-lived internal working context and must always have an expiry. Other users' stored context is signaled through member memory counts, and the read-only `list_memories` tool can retrieve portable user memories, self memories, or guild memories, including another guild by ID when context requires it.

Memory writes can happen after the visible reply loop has ended. The runtime starts a silent second native agent loop with the same assembled context style and only the `record_memory` tool available; it sends no Discord output and does not keep typing active. For duplicate avoidance, that memory pass also receives a volatile, bounded appendix of active memories for other human users visible in rendered chat history: newest visible users first, up to 10 users, 10 memories per user, and 100 rows total.

Ambient memory extraction is separate from reply triggering. When enabled, non-triggered human chatter is reviewed after `memoryExtraction.ambient.everyMessages` messages since the last successful memory pass in that channel, subject to `minIntervalSeconds` and `maxBatchMessages`. Successful post-reply memory passes reset the same channel checkpoint, so active bot conversations back off ambient extraction instead of double-paying for the same recent window.

## Schedules

Agent schedule tools are current-guild and current-channel scoped, and list/delete only pending schedules. Prompt context exposes only a pending count summary; IDs and details require `list_scheduled_messages`.

Slash commands are the broader admin surface for guild schedule inspection and manual management.

One-off timers longer than 2,147,483,647 ms must be chunked and re-armed because JavaScript timers cannot represent longer delays safely.

## Moderation

`timeout_user` is intentionally narrow: it is for rare, admin-requested Discord member timeouts only, and runtime validation must keep rejecting DMs, bot self-timeouts, known guild-owner targets, non-positive durations, and durations above ten minutes. Prompt/tool instructions should continue to direct the model to verify unclear admin status through `list_chat_users` before using it.

## Images And Voice

Image tool results become multimodal model input according to provider metadata. OpenRouter support is refreshed from `/api/v1/models?output_modalities=all`; Codex support comes from the pi-ai model registry. If metadata says the selected main model lacks `image` input, text-only models receive tool text or, when enabled, a fallback vision-model description; if metadata is unavailable, the agent tries native image input first and only falls back after an endpoint rejection.

Stored images are canonical sources. User-uploaded images are persisted as static WebP q90, resized only when their longest edge exceeds `imageMaxDimension` (default 4096). Generated bot images are persisted from the generated attachment bytes without generic lossy recompression, so PNG generations stay PNG. LLM context, fallback vision, captioning, and external image-fetch results use temporary compressed JPEG copies derived at runtime from the canonical source and then discarded.

GIF attachments, GIF-like embed previews, and sticker previews use the same canonical image path as user uploads: animated media is reduced to a first-frame static image for storage and model reads. The image row `source_kind` is the prompt-history contract that keeps those previews labeled as GIFs or stickers instead of ordinary static images.

`read_user_avatar` is a guild-scoped ephemeral image reader. It may resolve members by username, mention, or user ID and download the current Discord display avatar for model context, but it must not insert avatar images into SQLite or write avatar bytes to the image attachment store.

`codex_generate_image` is a state-changing image-generation tool, not an image-reading tool. It uses the configured ChatGPT/Codex OAuth token against the Codex Responses `image_generation` backend with explicit `gpt-image-2` settings and the resolved `imageGeneration.quality` config. Generated output requests default to WebP to avoid very large files, while sent bot images are stored from the actual returned bytes/mime/extension. The tool accepts stored chat `ImageIDs` and passes their canonical image bytes as image inputs when the generation request depends on a specific current, replied-to, or contextual image. 4K is gated behind the tool's explicit `4k` argument; standalone 4K requests use the direct `/images/generations` route and 4K reference/edit requests use the direct `/images/edits` JSON route with data-URL references, both with `gpt-image-2`, `quality: high`, and a validated explicit size. Non-4K requests use the Responses route by default; the direct Codex `/images/generations` probe remains available only as an opt-in debug fallback for eligible prompt-only requests. Generated buffers stay in memory only until Discord send, then the sent bot image is stored through the same SQLite/image-file path used for image attachments.

`codex_generate_image` requires the `image_generation` skill in visible reply loops. The tool definition remains visible for stable tool-list caching, but execution returns a recoverable tool result until `load_skill` has loaded the skill in the current agent loop. `cancel_agent_job` is intentionally not tied to that skill because the job runtime is broader than images.

Discord image generation runs through the generic in-memory async job runtime. The foreground model turn starts an `image_generation` job, gets an immediate tool result, and should acknowledge instead of waiting. The worker keeps a typing pulse, enforces the image timeout, optionally captions the generated image for future context, then replies to the original message with deterministic delivery text. Active and recently terminal image jobs are injected into volatile prompt context and into recent-history message metadata; these sections must stay uncached. Duplicate and replacement policy is enforced both by prompt instructions and by the job store/tool guards.

Response directive parsing is deliberately narrow. `<message>` separates intentional multi-message replies and may carry per-message delivery attributes such as `channel_id="<channel or thread id>"`, `reply="false"`, `reply_to="<message id>"`, `keep_typing="true"`, or `image_ids=[123]`; `<voice>`/`<audio>` sends audio, full-reply `<ignore>` suppresses output, and other XML remains normal text. `reply_to` resolves inside the selected destination channel. `image_ids` resolves same-guild stored chat images into Discord file attachments for that specific message envelope. Ignored replies are stored as `is_prompt_only` bot history so future assembled prompt history shows the intentional silence, but those rows are not embedded and are filtered from search/history tools. Closed `<message>` envelopes in streamed assistant turns are dispatched as they arrive, with unfinished/plain text flushed after completion; streamed follow-up bubbles are paced behind typing to avoid a buffered burst. `[msg-break]` is a history-only marker for merged separate messages, not an output directive. Do not add broad XML parsing.

ElevenLabs v3 bracket delivery tags inside `<voice>` are prompt policy, not code policy. Do not filter them in code.

## Config Changes

When adding or removing config fields, update the example config files, config types, loader logic, loader tests, README reference text, and any invariant in this file affected by the change.
