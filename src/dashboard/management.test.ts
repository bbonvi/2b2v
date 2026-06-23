import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createDatabase, type Database } from "../db/database";
import {
  deleteStoredManagementMessages,
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
