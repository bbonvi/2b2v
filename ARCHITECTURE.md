# Architecture

This file keeps maintainer invariants that are easy to break and not obvious from code shape alone. Setup, command reference, config inventories, and ordinary implementation details belong in code or `README.md`.

## Reply Loop

The persona model speaks directly. There is no hidden orchestrator model and no custom JSON action protocol.

Tool results are appended back to the same model turn. Read-only tools may run concurrently only when allowlisted; state-changing or unknown tools remain ordered barriers.

Provider-native reasoning blocks are internal. Keep them with matching native tool call IDs until the next request needs them, but never render them to Discord or persisted prompt-history text. Silent memory and relationship maintenance continuations must not be stored in the cross-run continuation store.

Tool-budget exhaustion is recoverable: pending calls receive synthetic results, then the model gets one final no-tools turn.

Typing is runtime-owned. Model work must not wait on typing simulation; pending typing indicators must be cancelled on visible output, ignore, error, or agent end.

Dispatch batches preserve the causal reply target. Debounced same-author follow-up text may join the current dispatch unit, but unrelated chatter and later triggers must not inherit another message's trigger reason.

Prompt history remains chronological at run time. The current Discord event pins the causal target; real trigger messages already stored in chat history should be marked, not re-appended as the newest line.

Thread tools manage thread state only. Later sends still require explicit `<message channel_id="...">` routing.

Cross-channel and cross-guild reads/sends must go through accessible Discord channels. DMs stay out of scope. Cross-guild bot sends store output under the target guild/channel while preserving source request metadata.

Message edit/delete tools must authorize against the live Discord message before mutating local state. They may only touch messages authored by the current bot user in accessible guild text channels/threads.

Ambient attention and initiative must re-check current chat state immediately before spending evaluator/generation work and again before visible send, so stale proactive replies can be dropped.

Stale-droppable proactive turns may use write tools. Once a write tool starts, the turn is committed: bypass stale pre-send drops, clear competing ambient candidates for that user/channel, and finish the reply. If a pre-send gate drops a read-only generation, do not run post-reply memory or relationship maintenance for that discarded generation.

## Prompt Cache

Stable prompt content must stay before volatile context. Dynamic sections such as time, current channel state, schedules, memories, recent history, current messages, and trigger instructions must stay after the stable prefix/anchor.

Prompt file loading must be deterministic. Missing template variables are errors; runtime template output must not depend on filesystem order, clocks, random values, or object iteration.

Older chat history moves only in configured trim chunks. Do not promote one message at a time into cached history.

Volatile social data, such as current display names and reaction counts, belongs only in recent uncached history.

## Relationship State

Relationship state is per Discord user, not per guild. Relationship extraction runs after replies and ignored/silent turns, after the memory pass, and never posts directly.

Normal replies receive only the active speaker relationship slice. Relationships are durable context, not a proactive activity queue or life simulation.

## History, Search, Memory

SQLite is the readable source of truth. Qdrant is only a semantic index; search results must join back to SQLite rows.

Discord-deleted messages are tombstoned as `[deleted]` in SQLite, not removed from prompt history; local media, reactions, and vector points are still removed.

Merged history rows must preserve all component Discord message IDs. Reply resolution and prompt-visible search exclusions must treat aliases as present.

`search_channel_messages` semantic/literal modes must exclude messages already visible in prompt history and overfetch before that filtering; id lookup may return visible messages so trimmed content can be expanded.

Rendered chat history exposes `oldest_visible_message_id` when stored prior context exists, so `list_channel_messages(before_message_id=...)` can page before the prompt window.

Memory scopes have product meaning: guild memories are server-local, user memories follow the Discord user across guilds, and self memories are the bot/persona's portable private context. Scratchpad memories must expire.

High-priority memories are selected before ordinary rows under caps and rendered with `[IMPORTANT]` near the bottom of the memory block.

Memory writes may happen after the visible reply loop. The silent memory pass sends no Discord output and does not keep typing active.

Ambient memory extraction is separate from reply triggering. Successful post-reply memory passes reset the same channel checkpoint so ambient extraction does not double-pay for active conversations.

## Safety Boundaries

`discord_set_user_timeout` and `discord_remove_user_timeout` are intentionally narrow: rare, admin-requested Discord member timeout changes only. Runtime validation must continue rejecting DMs, bot self-timeouts, known guild-owner targets, non-positive durations, and set durations above Discord's 28 day maximum.

Agent schedule tools are current-guild and current-channel scoped. One-off timers longer than JavaScript's maximum timeout must be chunked and re-armed.

Stored images are canonical sources. Runtime model reads may use temporary compressed copies, but must not replace the canonical attachment.

Avatar reads are ephemeral and guild-scoped. They must not write avatar bytes into SQLite or the image attachment store.

Image generation is state-changing async work. Foreground turns should start the job and acknowledge; workers handle typing, timeout, captioning, storage, and final delivery.

Response directive parsing is deliberately narrow. Do not add broad XML parsing.

ElevenLabs v3 bracket delivery tags inside `<voice>` are prompt policy, not code policy. Do not filter them in code.

## Config Changes

When adding or removing config fields, update example config, config types, loader logic, loader tests, README setup notes, and any invariant here affected by the change.
