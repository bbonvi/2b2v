import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database.ts";
import { createInnerThread } from "../db/inner-thread-repository.ts";
import { buildInnerThreadsContext } from "./inner-thread-service.ts";

describe("inner thread prompt context", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("renders an explicit empty applicable set", () => {
    const context = buildInnerThreadsContext({
      db,
      guildId: "guild-1",
      visibleUserIds: ["user-1"],
    });

    expect(context).toBe([
      "## Active Inner Threads",
      "No active inner threads are currently applicable.",
    ].join("\n"));
  });

  test("renders exact identities with readable current-guild recall and pressure labels", () => {
    createInnerThread(db, {
      content: "keep sharing small details without turning the exchange into an interview",
      aboutType: "user",
      aboutUserId: "user-1",
      recallScope: "guild",
      recallGuildId: "guild-1",
      recallMode: "users",
      recallUserIds: ["user-1"],
      salience: 0.7,
      pressure: 0.2,
      sourceMessageIds: ["message-1", "message-2"],
      sourceGuildId: "guild-1",
      sourceChannelId: "channel-1",
    });

    const context = buildInnerThreadsContext({
      db,
      guildId: "guild-1",
      visibleUserIds: ["user-1"],
      resolveUserId: (userId) => userId === "user-1" ? "alice" : undefined,
    });

    expect(context).toContain(
      "about=@alice (user-1) recall=current_guild/users:@alice salience=meaningful[0.70] pressure=low[0.20]",
    );
    expect(context).toContain(
      "source=guild:guild-1/channel:channel-1/messages:[message-1,message-2]",
    );
    expect(context).not.toContain("recall=guild:guild-1");
  });

  test("omits source metadata when a thread has no message anchor", () => {
    createInnerThread(db, {
      content: "consider whether the room has become too familiar",
      aboutType: "self",
      recallScope: "anywhere",
      recallMode: "always",
      salience: 0.4,
      pressure: 0.1,
    });

    const context = buildInnerThreadsContext({
      db,
      guildId: "guild-1",
      visibleUserIds: [],
    });

    expect(context).not.toContain("source=");
  });
});
