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
    expect(context).not.toContain("guild:guild-1");
  });
});
