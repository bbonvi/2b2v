import { SnowflakeUtil } from "discord.js";

export interface RestartCatchupMessage {
  id: string;
  createdTimestamp: number;
}

export interface RestartCatchupFetchResult<T extends RestartCatchupMessage> {
  messages: T[];
  capped: boolean;
  fetched: number;
}

/** Fetch a bounded chronological Discord message window after a restart cutoff. */
export async function fetchMessagesAfterRestart<T extends RestartCatchupMessage>(input: {
  cutoffAt: number;
  maxMessages: number;
  fetchAfter: (afterMessageId: string, limit: number) => Promise<readonly T[]>;
}): Promise<RestartCatchupFetchResult<T>> {
  const cutoffBoundary = SnowflakeUtil.generate({
    timestamp: Math.max(0, input.cutoffAt - 1),
    increment: 0n,
    workerId: 0n,
    processId: 0n,
  }).toString();
  const collected = new Map<string, T>();
  let afterMessageId = cutoffBoundary;
  let fetched = 0;
  let lastPageWasFull = false;

  while (fetched < input.maxMessages) {
    const limit = Math.min(100, input.maxMessages - fetched);
    const page = [...await input.fetchAfter(afterMessageId, limit)];
    if (page.length === 0) break;
    fetched += page.length;
    lastPageWasFull = page.length >= limit;

    let greatestId = afterMessageId;
    for (const message of page) {
      if (BigInt(message.id) > BigInt(greatestId)) greatestId = message.id;
      if (message.createdTimestamp >= input.cutoffAt) collected.set(message.id, message);
    }
    if (greatestId === afterMessageId) break;
    afterMessageId = greatestId;
    if (page.length < limit) break;
  }

  return {
    messages: [...collected.values()].sort((a, b) => {
      const timestampDiff = a.createdTimestamp - b.createdTimestamp;
      return timestampDiff !== 0 ? timestampDiff : BigInt(a.id) < BigInt(b.id) ? -1 : 1;
    }),
    capped: fetched >= input.maxMessages && lastPageWasFull,
    fetched,
  };
}
