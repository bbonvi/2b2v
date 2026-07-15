import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createDatabase, type Database } from "../db/database";
import { createMemory } from "../db/memory-repository";
import {
  deleteStoredManagementMessages,
  listManagementMemories,
  listManagementMessages,
  updateStoredManagementMessageContent,
} from "./management";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function insertMessage(id: string, opts: { guildId?: string; channelId?: string; createdAt?: number } = {}): void {
  db.raw
    .prepare(
      `INSERT INTO messages
         (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      opts.guildId ?? "g1",
      opts.channelId ?? "c1",
      "u1",
      "alice",
      `raw ${id}`,
      `translated ${id}`,
      0,
      opts.createdAt ?? Date.now(),
    );
}

describe("dashboard local message management", () => {
  test("lists latest stored messages by exact guild and channel", () => {
    insertMessage("older", { guildId: "g1", channelId: "c1", createdAt: 10 });
    insertMessage("newer", { guildId: "g1", channelId: "c1", createdAt: 20 });
    insertMessage("other-channel", { guildId: "g1", channelId: "c2", createdAt: 30 });

    expect(listManagementMessages(db, { guildId: "g1", channelId: "c1" }).map((row) => row.id))
      .toEqual(["newer", "older"]);
  });

  test("edits only the exact stored message row", () => {
    insertMessage("m1", { guildId: "g1", channelId: "c1" });
    insertMessage("m2", { guildId: "g2", channelId: "c9" });

    const updated = updateStoredManagementMessageContent(db, {
      id: "m1",
      guildId: "g1",
      channelId: "c1",
      content: "replacement",
    });

    expect(updated?.translatedContent).toBe("replacement");
    expect(listManagementMessages(db, { guildId: "g2", channelId: "c9" })[0]?.translatedContent)
      .toBe("translated m2");
  });

  test("deletes only requested rows in the validated guild and channel", () => {
    insertMessage("m1", { guildId: "g1", channelId: "c1" });
    insertMessage("m2", { guildId: "g1", channelId: "c1" });
    insertMessage("m3", { guildId: "g1", channelId: "c2" });

    const deleted = deleteStoredManagementMessages(db, {
      ids: ["m1", "m3"],
      guildId: "g1",
      channelId: "c1",
    });

    expect(deleted.messageIds).toEqual(["m1"]);
    expect(listManagementMessages(db, { guildId: "g1" }).map((row) => row.id).sort())
      .toEqual(["m2", "m3"]);
  });
});

describe("dashboard memory management", () => {
  test("lists important memories first, then newest first", () => {
    db.raw
      .prepare(
        `INSERT INTO memories
           (scope, guild_id, kind, content, confidence, priority, created_at, updated_at)
         VALUES
           ('guild', 'g1', 'fact', 'ordinary newer', 0.7, 0, 40, 40),
           ('guild', 'g1', 'fact', 'important older', 0.7, 1, 20, 20),
           ('guild', 'g1', 'fact', 'important newer', 0.7, 1, 30, 30)`
      )
      .run();

    expect(listManagementMemories(db, { guildId: "g1" }).map((row) => row.content))
      .toEqual(["important newer", "important older", "ordinary newer"]);
    expect(listManagementMemories(db, { guildId: "g1", important: true }).map((row) => row.content))
      .toEqual(["important newer", "important older"]);
    expect(listManagementMemories(db, { guildId: "g1", important: false }).map((row) => row.content))
      .toEqual(["ordinary newer"]);
  });

  test("filters by source channel, subject, applicability, kind, and lifecycle state", () => {
    insertMessage("source-active", { guildId: "g1", channelId: "c1" });
    insertMessage("source-other", { guildId: "g1", channelId: "c2" });
    const activeId = createMemory(db, {
      guildId: "g1",
      scope: "user",
      subjectUserId: "u1",
      appliesTo: ["u2"],
      kind: "preference",
      content: "active match",
      sourceMessageId: "source-active",
    });
    createMemory(db, {
      guildId: "g1",
      scope: "user",
      subjectUserId: "u3",
      appliesTo: "all",
      kind: "fact",
      content: "other source",
      sourceMessageId: "source-other",
    });
    const deletedId = createMemory(db, {
      guildId: "g1",
      kind: "fact",
      content: "deleted row",
    });
    db.raw.prepare("UPDATE memories SET deleted_at = ? WHERE id = ?").run(Date.now(), deletedId);

    const matches = listManagementMemories(db, {
      channelId: "c1",
      scope: "user",
      kind: "preference",
      subjectUserId: "u1",
      applicableToUserId: "u2",
    });
    expect(matches.map((row) => row.id)).toEqual([activeId]);
    expect(matches[0]?.sourceGuildId).toBe("g1");
    expect(matches[0]?.sourceChannelId).toBe("c1");
    expect(listManagementMemories(db, { status: "deleted" }).map((row) => row.id)).toContain(deletedId);
  });

  test("content search escapes wildcard characters", () => {
    createMemory(db, { guildId: "g1", kind: "fact", content: "literal 100% marker" });
    createMemory(db, { guildId: "g1", kind: "fact", content: "literal 1000 marker" });

    expect(listManagementMemories(db, { query: "100%" }).map((row) => row.content))
      .toEqual(["literal 100% marker"]);
  });
});
