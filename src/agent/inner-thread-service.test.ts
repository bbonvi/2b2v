import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import { createDatabase, type Database } from "../db/database.ts";
import { createInnerThread, listInnerThreads, updateInnerThread } from "../db/inner-thread-repository.ts";
import {
  buildInnerThreadMaintenanceContext,
  buildInnerThreadsContext,
  createRecordInnerThreadsTool,
} from "./inner-thread-service.ts";

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
      "The active list is a bounded applicability view, not the full store; absence does not prove that no equivalent exists.",
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
      "source_msgs=[message-1,message-2]",
    );
    expect(context).not.toContain("source=guild:");
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

  test("creates, preserves, replaces, and clears up to three source message IDs", async () => {
    const tool = createRecordInnerThreadsTool({
      db,
      guildId: "guild-1",
      channelId: "channel-1",
      description: "Maintain inner threads.",
    });
    const fields = {
      about: { type: "self" },
      recall: { scope: "anywhere", mode: "always" },
      salience: 0.4,
      pressure: 0.2,
    } as const;
    expect(Value.Check(tool.parameters, {
      actions: [{
        action: "create",
        content: "too many sources",
        ...fields,
        source_message_ids: ["m1", "m2", "m3", "m4"],
      }],
    })).toBe(false);

    await tool.execute("create", {
      actions: [{
        action: "create",
        content: "continue the source discussion",
        ...fields,
        source_message_ids: ["m1", "m2", "m3"],
      }],
    });
    const id = listInnerThreads(db, { limit: 1 })[0]?.id;
    expect(id).toBeDefined();
    if (id === undefined) return;
    expect(listInnerThreads(db, { limit: 1 })[0]?.sourceMessageIds).toEqual(["m1", "m2", "m3"]);

    await tool.execute("preserve", {
      actions: [{ action: "update", id, content: "preserve the sources" }],
    });
    expect(listInnerThreads(db, { limit: 1 })[0]?.sourceMessageIds).toEqual(["m1", "m2", "m3"]);

    await tool.execute("replace", {
      actions: [{ action: "update", id, source_message_ids: ["m4", "m5"] }],
    });
    expect(listInnerThreads(db, { limit: 1 })[0]?.sourceMessageIds).toEqual(["m4", "m5"]);

    await tool.execute("clear", {
      actions: [{ action: "update", id, source_message_ids: null }],
    });
    expect(listInnerThreads(db, { limit: 1 })[0]?.sourceMessageIds).toEqual([]);
  });

  test("requires and records a short outcome when resolving a thread", async () => {
    const thread = createInnerThread(db, {
      content: "decide whether to accept the apology",
      aboutType: "user",
      aboutUserId: "user-1",
      recallScope: "anywhere",
      recallMode: "users",
      recallUserIds: ["user-1"],
      salience: 0.7,
      pressure: 0.8,
    });
    const tool = createRecordInnerThreadsTool({
      db,
      guildId: "guild-2",
      channelId: "channel-2",
    });

    expect(Value.Check(tool.parameters, {
      actions: [{ action: "resolve", id: thread.id }],
    })).toBe(false);

    await tool.execute("resolve", {
      actions: [{
        action: "resolve",
        id: thread.id,
        resolution_note: "accepted the apology in #repairs",
      }],
    });

    const resolved = listInnerThreads(db, { status: "resolved", limit: 1 })[0];
    expect(resolved?.content).toBe(
      "decide whether to accept the apology — resolved: accepted the apology in #repairs",
    );
    expect(resolved?.pressure).toBe(0);
  });

  test("shows only applicable resolutions from the last four hours", () => {
    const now = 10 * 60 * 60 * 1_000;
    const createResolved = (input: {
      content: string;
      updatedAt: number;
      recallGuildId?: string;
      recallUserIds?: string[];
    }): void => {
      const thread = createInnerThread(db, {
        content: input.content,
        aboutType: "user",
        aboutUserId: "user-1",
        recallScope: input.recallGuildId === undefined ? "anywhere" : "guild",
        recallGuildId: input.recallGuildId,
        recallMode: "users",
        recallUserIds: input.recallUserIds ?? ["user-1"],
        salience: 0.5,
        pressure: 0.5,
        now: input.updatedAt - 1,
      });
      updateInnerThread(db, thread.id, {
        content: `${input.content} — resolved: closed elsewhere`,
        status: "resolved",
        pressure: 0,
      }, {
        action: "resolve",
        guildId: "guild-2",
        channelId: "channel-2",
        now: input.updatedAt,
      });
    };
    createResolved({ content: "recent portable thread", updatedAt: now - 1_000 });
    createResolved({ content: "second recent thread", updatedAt: now - 2_000 });
    createResolved({ content: "third recent thread", updatedAt: now - 3_000 });
    createResolved({ content: "fourth recent thread", updatedAt: now - 4_000 });
    createResolved({ content: "old portable thread", updatedAt: now - 4 * 60 * 60 * 1_000 - 1 });
    createResolved({
      content: "recent hidden user thread",
      updatedAt: now - 500,
      recallUserIds: ["user-2"],
    });
    createResolved({
      content: "recent other-guild thread",
      updatedAt: now - 500,
      recallGuildId: "guild-2",
    });

    const context = buildInnerThreadsContext({
      db,
      guildId: "guild-1",
      visibleUserIds: ["user-1"],
      now,
    });

    expect(context).toContain("## Recently Resolved Inner Threads");
    expect(context).toContain("recent portable thread — resolved: closed elsewhere");
    expect(context).toContain("second recent thread");
    expect(context).toContain("third recent thread");
    expect(context).not.toContain("fourth recent thread");
    expect(context).not.toContain("old portable thread");
    expect(context).not.toContain("recent hidden user thread");
    expect(context).not.toContain("recent other-guild thread");
  });

  test("gives maintenance bounded nearby and recent threads without repeating actor context", () => {
    const now = 10_000;
    createInnerThread(db, {
      content: "already visible active thread",
      aboutType: "user",
      aboutUserId: "user-1",
      recallScope: "anywhere",
      recallMode: "users",
      recallUserIds: ["user-1"],
      salience: 0.5,
      pressure: 0.5,
      now: now - 4,
    });
    createInnerThread(db, {
      content: "nearby cross-guild thread",
      aboutType: "user",
      aboutUserId: "user-1",
      recallScope: "guild",
      recallGuildId: "guild-2",
      recallMode: "users",
      recallUserIds: ["user-2"],
      salience: 0.5,
      pressure: 0.5,
      now: now - 3,
    });
    createInnerThread(db, {
      content: "recent unrelated thread",
      aboutType: "self",
      recallScope: "guild",
      recallGuildId: "guild-2",
      recallMode: "always",
      salience: 0.5,
      pressure: 0.5,
      now: now - 2,
    });

    const context = buildInnerThreadMaintenanceContext({
      db,
      guildId: "guild-1",
      visibleUserIds: ["user-1"],
      now,
      resolveGuildId: (guildId) => guildId === "guild-2" ? "Other Guild" : undefined,
    });

    expect(context).toContain("## Other Nearby and Recent Inner Threads");
    expect(context).toContain("### Nearby");
    expect(context).toContain("nearby cross-guild thread");
    expect(context).toContain("recall=guild:Other Guild/users:user-2");
    expect(context).toContain("### Recent");
    expect(context).toContain("recent unrelated thread");
    expect(context).not.toContain("already visible active thread");
  });
});
