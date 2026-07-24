# Event filters

Use one atomic event:

- `message`: optional user, exact webhook, ripgrep regex `pattern`, asset kind, or explicit self inclusion. Use `webhookMessageId` to resolve a visible stored webhook message without guessing its hidden webhook ID. Omitted filters mean any message.
- `presence_transition`: optional user plus optional source statuses and required destination statuses. `idle` means away; invisible is observed as offline.
- `presence_state`: optional user and required current statuses.
- `voice`: optional user, join/leave/move, and optional voice channel.
- `member`: optional user and guild join/leave.
- `reaction`: optional reactor, add/remove, message, emoji, or current aggregate `countAtLeast`.

Omit `userId` for any user. Use `occurrences` only for one rolling count within a duration; do not combine it with reaction `countAtLeast`. Use `after` as daily `HH:mm` or absolute `YYYY-MM-DD HH:mm`.
