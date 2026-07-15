# Architecture

This file records cross-cutting decisions whose intent is not obvious from one implementation site. Setup, schemas, configuration inventories, UI behavior, and ordinary control flow belong in code, tests, or `README.md`.

## Turn And Event Ownership

Provider-native reasoning is private continuation state. Keep it attached to its matching native tool-call IDs, never render it to Discord or prompt-history text, and never save silent maintenance continuations for later visible turns.

Accepted work before a restart cutoff belongs to the old process and must drain there. The new process owns only events recovered after that cutoff. Catch-up repairs missed Discord history; it is not crash replay and must not reconstruct stale typing, random triggers, or ambient candidates.

A dispatch batch has one causal reply target. Same-author text may be debounced into that batch, but unrelated chatter and later triggers must not inherit its trigger reason.

External bots may use deliberate mention, reply, and keyword paths. They do not qualify for random or ambient attention, and this bot's own messages must never re-enter its reply loop.

Proactive turns are discardable until their first write action. After a write begins, the turn is committed: stale-send gates must not abandon it, and competing proactive work for the same user/channel must yield.

## Prompt Boundaries

Stable prompt sections precede volatile context. Time, live room state, schedules, memories, recent history, current events, and trigger instructions must stay after the cacheable prefix.

Persona identity and behavioral policy belong under `profiles/<profile>/instructions/`; shared instructions must remain persona-neutral. Runtime source may contain only small atomic guardrails that are genuinely code-adjacent.

Persona modes may temporarily override presentation, tone, and ordinary style. They cannot override authorization, safety boundaries, tool contracts, or factual integrity. Guild-scoped modes may use guild-member presentation, but global presence remains account-wide.

## Durable State Semantics

Relationship state follows a Discord user across guilds. It is context for later interaction, not an initiative queue or simulated life state.

Discord deletion is represented rather than rewritten: retained text is marked deleted in prompt history while locally held media and reactions are removed.

Merged history must preserve every component Discord message ID because reply resolution and prompt exclusions depend on those aliases.

Memory ownership, recall location, and relevance are independent dimensions. Never infer one from another. Community memory is guild-local, and scratchpad memory must expire.

## Authorization And Privacy

Cross-channel and cross-guild operations require live access to the source and destination guild channels. DMs remain out of scope. Edit and delete operations must additionally verify the live Discord message is authored by the current bot.

Asset IDs may cross guild boundaries only while the caller can still access the source channel. Signed Discord URLs are never persisted. Cached transcripts must be re-authorized against live channel access before disclosure.

External image retrieval must reject private-network targets and revalidate every redirect. Web image bytes, Discord avatars, and signed attachment bytes remain ephemeral; accepted public image-generation URLs may be retained only as private job provenance.

Member timeout tools remain deliberately narrower than Discord's API: guild only, admin-requested, never the bot or known guild owner, positive duration, and at most Discord's 28-day limit.

## Asynchronous Work

Visible output, ignore, error, and agent termination all end runtime-owned typing. Model work never waits for typing simulation.

Image generation is durable state-changing work. Exact effective input, replacement lineage, result, and delivery state survive process loss; process-local abort handles do not. Work abandoned by an uncoordinated restart becomes terminally interrupted rather than appearing active forever.
