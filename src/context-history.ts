import type { ContextHistoryConfig } from "./config/types.ts";

/** Return how many oldest messages to remove at the current rollover boundary. */
export function contextHistoryDropCount(
  totalMessages: number,
  config: ContextHistoryConfig,
): number {
  if (totalMessages < config.retainedMessages + config.recentMessages) return 0;
  return Math.floor(
    (totalMessages - config.retainedMessages) / config.recentMessages,
  ) * config.recentMessages;
}

/** Return the stable older-prefix size while reserving a recent tail. */
export function contextHistoryOlderSize(
  retainedMessages: number,
  config: ContextHistoryConfig,
): number {
  const capacity = config.retainedMessages - config.recentMessages;
  const desired = Math.max(0, retainedMessages - config.recentMessages);
  if (desired >= capacity) return capacity;
  return Math.floor(desired / config.recentMessages) * config.recentMessages;
}
