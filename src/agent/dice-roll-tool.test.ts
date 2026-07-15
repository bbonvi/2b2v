import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TextContent } from "@earendil-works/pi-ai";
import { createDatabase, type Database } from "../db/database";
import { getDiceRollByRequestKey } from "../db/dice-roll-repository";
import { createDiceRollTool, renderDiceRollMessage, type DiceRollDelivery } from "./dice-roll-tool";

describe("createDiceRollTool", () => {
  let db: Database;
  let deliveries: DiceRollDelivery[];

  beforeEach(() => {
    db = createDatabase(":memory:");
    deliveries = [];
  });

  afterEach(() => {
    db.close();
  });

  function createTool(randomValues: number[], deliver?: (input: DiceRollDelivery) => Promise<{ sentMessageId: string }>) {
    let index = 0;
    return createDiceRollTool({
      db,
      guildId: "guild-1",
      channelId: "channel-1",
      currentRequest: {
        requesterId: "user-1",
        requesterUsername: "V",
        sourceMessageId: "message-1",
      },
      resolveActor: (reference) => Promise.resolve(reference === "2B"
        ? { userId: "user-2", username: "2B" }
        : null),
      deliver: deliver ?? ((input) => {
        deliveries.push(input);
        return Promise.resolve({ sentMessageId: `result-${deliveries.length}` });
      }),
      randomInteger: (minimum, maximumExclusive) => {
        const value = randomValues[index];
        index += 1;
        if (value === undefined || value < minimum || value >= maximumExclusive) {
          throw new Error("Invalid deterministic test roll.");
        }
        return value;
      },
    });
  }

  test("posts and audits a normal roll with a free-form label", async () => {
    const tool = createTool([2, 6, 4]);
    const result = await tool.execute("call-1", {
      count: 3,
      sides: 6,
      modifier: 2,
      label: "break the lock @everyone :party:",
    }, AbortSignal.timeout(5000));

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.sourceMessageId).toBe("message-1");
    expect(deliveries[0]?.text).toContain("**V** rolled `3d6 + 2`");
    expect(deliveries[0]?.text).toContain("# 14");
    expect(deliveries[0]?.text).toContain("break the lock @\u200Beveryone :\u200Bparty:\u200B");

    const roll = getDiceRollByRequestKey(db, "guild-1:channel-1:message-1:call-1");
    expect(roll?.rolls).toEqual([2, 6, 4]);
    expect(roll?.resultMessageId).toBe("result-1");
    expect((result.content[0] as TextContent).text).toContain("rolls=[2, 6, 4]");
    expect((result.content[0] as TextContent).text).toContain("total=14");
    expect((result.content[0] as TextContent).text).not.toContain("kept=");
  });

  test("keeps the higher die for advantage and can attribute the roll", async () => {
    const tool = createTool([7, 18]);
    await tool.execute("call-2", {
      sides: 20,
      modifier: -1,
      mode: "advantage",
      actor: "2B",
    }, AbortSignal.timeout(5000));

    const roll = getDiceRollByRequestKey(db, "guild-1:channel-1:message-1:call-2");
    expect(roll).toMatchObject({
      actorUserId: "user-2",
      actorUsername: "2B",
      rolls: [7, 18],
      kept: [18],
      total: 17,
    });
    expect(deliveries[0]?.text).toContain("`1d20 advantage − 1`");
    expect(deliveries[0]?.text).toContain("# 17");
    expect(deliveries[0]?.text).toContain("Rolls: `7, 18` · Kept: `18`");
  });

  test("evaluates an optional target against the modified total", async () => {
    const successTool = createTool([11]);
    const success = await successTool.execute("call-success", {
      sides: 20,
      modifier: 3,
      target: 14,
      label: "Dexterity check",
    }, AbortSignal.timeout(5000));

    expect(getDiceRollByRequestKey(db, "guild-1:channel-1:message-1:call-success")).toMatchObject({
      total: 14,
      target: 14,
      succeeded: true,
    });
    expect(deliveries[0]?.text).toContain("✅ Success · Target: `14`");
    expect((success.content[0] as TextContent).text).toContain("target=14");
    expect((success.content[0] as TextContent).text).toContain("threshold_outcome=success");

    const failureTool = createTool([10]);
    const failure = await failureTool.execute("call-failure", {
      target: 14,
    }, AbortSignal.timeout(5000));
    expect(getDiceRollByRequestKey(db, "guild-1:channel-1:message-1:call-failure")).toMatchObject({
      total: 10,
      target: 14,
      succeeded: false,
    });
    expect(deliveries[1]?.text).toContain("❌ Failure · Target: `14`");
    expect((failure.content[0] as TextContent).text).toContain("threshold_outcome=failure");
  });

  test("retries a pending delivery without rolling again", async () => {
    let attempts = 0;
    const tool = createTool([11], (input) => {
      deliveries.push(input);
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("temporary Discord failure"))
        : Promise.resolve({ sentMessageId: "result-retried" });
    });

    const first = await tool.execute("call-retry", {}, AbortSignal.timeout(5000));
    expect((first.content[0] as TextContent).text).toContain("temporary Discord failure");
    const second = await tool.execute("call-retry", { sides: 100 }, AbortSignal.timeout(5000));

    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]?.text).toBe(deliveries[0]?.text ?? "");
    expect(getDiceRollByRequestKey(db, "guild-1:channel-1:message-1:call-retry")).toMatchObject({
      sides: 20,
      rolls: [11],
      resultMessageId: "result-retried",
    });
    expect((second.content[0] as TextContent).text).toContain("rolls=[11]");
    expect((second.content[0] as TextContent).text).toContain("total=11");
  });

  test("does not post a duplicate for an already delivered tool call", async () => {
    const tool = createTool([9]);
    await tool.execute("call-idempotent", {}, AbortSignal.timeout(5000));
    const result = await tool.execute("call-idempotent", {}, AbortSignal.timeout(5000));

    expect(deliveries).toHaveLength(1);
    expect((result.content[0] as TextContent).text).toContain("Already posted");
    expect((result.content[0] as TextContent).text).toContain("rolls=[9]");
    expect((result.content[0] as TextContent).text).toContain("total=9");
  });

  test("rejects multi-die advantage and unknown actors", async () => {
    const tool = createTool([]);
    const invalidMode = await tool.execute("bad-mode", {
      count: 2,
      mode: "advantage",
    }, AbortSignal.timeout(5000));
    const invalidActor = await tool.execute("bad-actor", {
      actor: "nobody",
    }, AbortSignal.timeout(5000));

    expect((invalidMode.content[0] as TextContent).text).toContain("requires count=1");
    expect((invalidActor.content[0] as TextContent).text).toContain("No exact guild user matched");
    expect(deliveries).toHaveLength(0);
  });
});

describe("renderDiceRollMessage", () => {
  test("renders the stored result without requiring live Discord state", () => {
    expect(renderDiceRollMessage({
      id: "roll-1",
      requestKey: "request-1",
      guildId: "guild-1",
      channelId: "channel-1",
      sourceMessageId: "source-1",
      resultMessageId: null,
      requestedByUserId: "user-1",
      actorUserId: "user-1",
      actorUsername: "V",
      count: 1,
      sides: 12,
      modifier: 0,
      mode: "normal",
      label: null,
      rolls: [12],
      kept: [12],
      total: 12,
      target: null,
      succeeded: null,
      createdAt: 1,
      deliveredAt: null,
    })).toBe("## 🎲 Dice roll\n**V** rolled `1d12`\n# 12");
  });
});
