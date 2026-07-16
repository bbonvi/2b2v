import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TextContent } from "@earendil-works/pi-ai";
import { createDatabase, type Database } from "../db/database";
import { getDiceRollByRequestKey } from "../db/dice-roll-repository";
import { createDiceRollTool, renderDiceRollMessage, type DiceRollDelivery, type PrivateDiceRollRecord } from "./dice-roll-tool";

describe("createDiceRollTool", () => {
  let db: Database;
  let deliveries: DiceRollDelivery[];
  let privateRecords: PrivateDiceRollRecord[];

  beforeEach(() => {
    db = createDatabase(":memory:");
    deliveries = [];
    privateRecords = [];
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
      sourceUsername: "2B",
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
      recordPrivate: (input) => {
        privateRecords.push(input);
        return Promise.resolve();
      },
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
      label: "break & \"lock\" @everyone :party:",
    }, AbortSignal.timeout(5000));

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.sourceMessageId).toBe("message-1");
    expect(deliveries[0]?.text).toContain("# `🎲 14`");
    expect(deliveries[0]?.text).toContain("`V` `3d6+2` `Dice (🎲 2 🎲 6 🎲 4)`");
    expect(deliveries[0]?.text).toContain("break & \"lock\" @\u200Beveryone :\u200Bparty:\u200B");
    expect(deliveries[0]?.historyText).toContain('label="break &amp; &quot;lock&quot; @everyone :party:"');

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
      actor_name: "Nines",
      trait: "Ловкость",
      lang: "ru",
    }, AbortSignal.timeout(5000));

    const roll = getDiceRollByRequestKey(db, "guild-1:channel-1:message-1:call-2");
    expect(roll).toMatchObject({
      actorUserId: "user-2",
      actorUsername: "2B",
      actorName: "Nines",
      trait: "Ловкость",
      lang: "ru",
      rolls: [7, 18],
      kept: [18],
      total: 17,
    });
    expect(deliveries[0]?.text).toBe("# `🎲 17`\n\n`Nines` `Ловкость` `d20-1` `🟢 Преимущество (🎲 7 🎲 18)`");
    expect(deliveries[0]?.historyText).toContain('actor_name="Nines" lang="ru" trait="Ловкость"');
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
    expect(deliveries[0]?.text).toContain("# ✅ SUCCESS `🎲 14`");
    expect(deliveries[0]?.text).toContain("## Dexterity check — Difficulty `14`");
    expect(deliveries[0]?.text).toContain("`V` `d20+3`");
    expect((success.content[0] as TextContent).text).toContain("target=14");
    expect((success.content[0] as TextContent).text).toContain("threshold_outcome=success");
    expect((success.content[0] as TextContent).text).toContain("Check PASSED: total 14 met target 14.");

    const failureTool = createTool([10]);
    const failure = await failureTool.execute("call-failure", {
      target: 14,
    }, AbortSignal.timeout(5000));
    expect(getDiceRollByRequestKey(db, "guild-1:channel-1:message-1:call-failure")).toMatchObject({
      total: 10,
      target: 14,
      succeeded: false,
    });
    expect(deliveries[1]?.text).toContain("# ❌ FAILURE `🎲 10`");
    expect(deliveries[1]?.text).toContain("## Check — Difficulty `14`");
    expect((failure.content[0] as TextContent).text).toContain("threshold_outcome=failure");
    expect((failure.content[0] as TextContent).text).toContain("Check FAILED: total 10 did not meet target 14.");
  });

  test("renders a localized disadvantage badge with both dice", async () => {
    const tool = createTool([4, 17]);
    await tool.execute("call-disadvantage", {
      modifier: 2,
      target: 12,
      mode: "disadvantage",
      label: "Удержать равновесие",
      trait: "Ловкость (Акробатика)",
      actor_name: "Бонан",
      lang: "ru",
    }, AbortSignal.timeout(5000));

    expect(deliveries[0]?.text).toBe([
      "# ❌ ПРОВАЛ `🎲 6`",
      "## Удержать равновесие — Сложность `12`",
      "",
      "`Бонан` `Ловкость (Акробатика)` `d20+2` `🔴 Помеха (🎲 4 🎲 17)`",
    ].join("\n"));
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

  test("records a private roll in prompt history without posting a widget", async () => {
    const tool = createTool([8]);
    const first = await tool.execute("call-private", {
      modifier: 2,
      target: 13,
      private: true,
      label: "Hidden danger",
    }, AbortSignal.timeout(5000));
    const second = await tool.execute("call-private", { private: false }, AbortSignal.timeout(5000));

    expect(deliveries).toHaveLength(0);
    expect(privateRecords).toHaveLength(1);
    expect(privateRecords[0]?.historyText).toContain('visibility="private"');
    expect(privateRecords[0]?.historyText).toContain('total="10" target="13" outcome="failure"');
    const stored = getDiceRollByRequestKey(db, "guild-1:channel-1:message-1:call-private");
    expect(stored).toMatchObject({
      isPrivate: true,
      resultMessageId: null,
      total: 10,
    });
    expect(stored?.deliveredAt).not.toBeNull();
    expect((first.content[0] as TextContent).text).toContain("Canonical private dice result");
    expect((first.content[0] as TextContent).text).toContain("No public Discord message was sent");
    expect((second.content[0] as TextContent).text).toContain("Canonical private dice result");
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
      actorName: "V",
      count: 1,
      sides: 12,
      modifier: 0,
      mode: "normal",
      label: null,
      trait: null,
      lang: "en",
      isPrivate: false,
      rolls: [12],
      kept: [12],
      total: 12,
      target: null,
      succeeded: null,
      createdAt: 1,
      deliveredAt: null,
    })).toBe("# `🎲 12`\n\n`V` `d12`");
  });
});
