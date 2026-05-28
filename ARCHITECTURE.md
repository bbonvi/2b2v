# Architecture

This file records invariants that are easy to break and not obvious from file names. Prefer code and tests for ordinary module maps, option lists, and implementation inventory.

## Reply Loop

`src/agent/handler.ts` is the reply control plane. The persona model speaks directly; there is no hidden orchestrator model and no custom JSON action protocol.

Tool results are appended as `role: "tool"` messages, then the same model produces final text. Read-only tools may run concurrently only when they are in the same model turn and on the allowlist. State-changing or unknown tools remain ordered execution barriers.

`start_thread` changes only final-answer routing: after the tool creates a thread, the assistant's final answer is sent there.

Tool-budget exhaustion is recoverable. Pending tool calls get synthetic results, then the model gets one final no-tools turn to answer from available context.

Typing is runtime-owned. The model has no typing tool.

## Prompt Cache

Prompt caching depends on stable content staying stable. The handler sends one merged stable prefix, adds cache breakpoints inside that block, then inserts a tiny stable user/assistant anchor before volatile turn context.

Dynamic sections such as current time, current channel state, pending schedule summary, memories, recent history, current user messages, and trigger instructions must stay after the anchor.

Older chat history moves only in `trim.windowSize` chunks. Do not promote one message at a time from recent history to older cached history.

`ReplyMsgID` is resolved internally for quote and image context, but is intentionally hidden from normal prompt history until direct replies are explicitly supported.

Merged history rows must preserve all component Discord message IDs. Reply resolution and prompt-visible search exclusions must treat aliases as present, not only the retained first ID.

## History, Search, Memory

SQLite is the source of truth for readable state. Qdrant is only a semantic index; search results must join back to SQLite rows.

`search_messages` excludes messages already visible in prompt history. Semantic search overfetches before this filtering so small result limits do not go empty just because top hits are already in context.

Memory is direct SQLite data, not a chat-visible tool. The prompt gets global memories plus current-user memories; other users' stored context is signaled only indirectly, such as through member memory counts.

## Schedules

Agent schedule tools are current-guild and current-channel scoped, and list/delete only pending schedules. Prompt context exposes only a pending count summary; IDs and details require `list_scheduled_messages`.

Slash commands are the broader admin surface for guild schedule inspection and manual management.

One-off timers longer than 2,147,483,647 ms must be chunked and re-armed because JavaScript timers cannot represent longer delays safely.

## Images And Voice

Image tool results become multimodal model input only when `resolveModel(...).input` advertises image support. Text-only models receive tool text or, when enabled, a fallback vision-model description.

Response directive parsing is deliberately narrow. `<voice>` sends audio, `<ignore>` suppresses output, and other XML remains normal text. Do not add broad XML parsing.

ElevenLabs v3 bracket delivery tags inside `<voice>` are prompt policy, not code policy. Do not filter them in code.

## Config Changes

When adding or removing config fields, update the example config files, config types, loader logic, loader tests, README reference text, and any invariant in this file affected by the change.
