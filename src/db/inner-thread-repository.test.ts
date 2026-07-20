import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "./database.ts";
import {
  createInnerThread,
  listApplicableInnerThreads,
  listInnerThreadEvents,
  updateInnerThread,
} from "./inner-thread-repository.ts";

describe("inner thread repository", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("applies guild and participant recall without leaking private scope", () => {
    const global = createInnerThread(db, {
      content: "general unresolved curiosity",
      aboutType: "self",
      recallScope: "anywhere",
      recallMode: "always",
      salience: 0.4,
      pressure: 0.2,
    });
    const guildPrivate = createInnerThread(db, {
      content: "alice promised a guild-specific update",
      aboutType: "user",
      aboutUserId: "alice",
      recallScope: "guild",
      recallGuildId: "g1",
      recallMode: "users",
      recallUserIds: ["alice"],
      salience: 0.9,
      pressure: 0.8,
      sourceGuildId: "g1",
      sourceChannelId: "c1",
      sourceMessageIds: ["m1"],
    });

    expect(listApplicableInnerThreads(db, {
      guildId: "g1",
      visibleUserIds: ["alice"],
    }).map((thread) => thread.id)).toEqual([guildPrivate.id, global.id]);
    expect(listApplicableInnerThreads(db, {
      guildId: "g1",
      visibleUserIds: ["bob"],
    }).map((thread) => thread.id)).toEqual([global.id]);
    expect(listApplicableInnerThreads(db, {
      guildId: "g2",
      visibleUserIds: ["alice"],
    }).map((thread) => thread.id)).toEqual([global.id]);
  });

  test("records lifecycle events and excludes resolved threads", () => {
    const thread = createInnerThread(db, {
      content: "waiting for an answer",
      aboutType: "community",
      recallScope: "guild",
      recallGuildId: "g1",
      recallMode: "always",
      salience: 0.8,
      pressure: 0.9,
      requestId: "req-create",
    });
    updateInnerThread(db, thread.id, {
      status: "resolved",
      pressure: 0,
    }, {
      action: "resolve",
      requestId: "req-resolve",
    });

    expect(listApplicableInnerThreads(db, { guildId: "g1" })).toEqual([]);
    expect(listInnerThreadEvents(db).map((event) => event.action)).toEqual([
      "resolve",
      "create",
    ]);
  });
});
