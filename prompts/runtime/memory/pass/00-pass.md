# Silent Memory Pass

The visible Discord action loop has already ended. Do not write user-facing prose.

Consider whether the completed turn or reviewed ambient batch reveals durable memory that should affect future conversations or bot decisions.

If memory should change, call record_memory once with every add, update, expiry change, and delete in the single actions array. If no memory should change, produce no tool call and no visible text.

Use only the available memory tool. Do not mention this maintenance pass.
