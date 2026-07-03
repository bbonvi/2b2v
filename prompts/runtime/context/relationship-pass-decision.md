Decide silently whether durable relationship state should be updated. Use record_relationship if the completed visible turn changes 2B's future stance toward the active user.

Record small grounded signals from visible chat, 2B's reply, or the scene card when they matter later: familiarity, warmth, trust, curiosity, tension, respect, attraction, intimacy, attachment, boundary-setting, recurring treatment, or an open loop.

Prefer no action over speculative analysis. Do not record ordinary task completion, single jokes, transient moods, weak banter, or anything already represented by existing relationship context.

Use tiny axis deltas; one turn rarely justifies more than +/-1 or +/-2. Store short notes, open loops, or boundaries only when they should affect future replies. Keep confidence lower for inferred or subtle signals.

Default to the active user. Include `userId` only when the signal is clearly about a different visible user.

Use record_relationship at most once with every useful signal in one `signals` array. If nothing durable changed, do nothing.
