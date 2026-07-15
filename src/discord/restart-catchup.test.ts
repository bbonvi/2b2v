import { describe, expect, test } from "bun:test";
import { SnowflakeUtil } from "discord.js";
import { fetchMessagesAfterRestart, type RestartCatchupMessage } from "./restart-catchup";

function message(timestamp: number, increment: bigint): RestartCatchupMessage {
  return {
    id: SnowflakeUtil.generate({ timestamp, increment, workerId: 0n, processId: 0n }).toString(),
    createdTimestamp: timestamp,
  };
}

describe("fetchMessagesAfterRestart", () => {
  test("paginates and returns messages chronologically from the cutoff", async () => {
    const messages = [message(1_002, 2n), message(1_001, 1n), message(999, 0n)];
    let calls = 0;

    const result = await fetchMessagesAfterRestart({
      cutoffAt: 1_000,
      maxMessages: 3,
      fetchAfter: (_after, limit) => {
        calls += 1;
        return Promise.resolve(calls === 1 ? messages.slice(0, limit) : []);
      },
    });

    expect(result.messages.map((item) => item.createdTimestamp)).toEqual([1_001, 1_002]);
    expect(result.fetched).toBe(3);
    expect(result.capped).toBe(true);
  });

  test("advances with the greatest snowflake across bounded pages", async () => {
    const first = Array.from({ length: 100 }, (_item, index) => message(2_001, BigInt(index)));
    const second = [message(2_002, 101n)];
    const cursors: string[] = [];

    const result = await fetchMessagesAfterRestart({
      cutoffAt: 2_000,
      maxMessages: 102,
      fetchAfter: (after) => {
        cursors.push(after);
        return Promise.resolve(cursors.length === 1 ? first : second);
      },
    });

    expect(cursors).toHaveLength(2);
    expect(BigInt(cursors[1] ?? "0")).toBe(BigInt(first.at(-1)?.id ?? "0"));
    expect(result.messages).toHaveLength(101);
    expect(result.capped).toBe(false);
  });
});
