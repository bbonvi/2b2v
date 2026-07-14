import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database";
import { createDashboardManagementRuntime } from "./management-runtime";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function insertMessage(id: string): void {
  db.raw
    .prepare(
      `INSERT INTO messages
         (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
       VALUES (?, 'g1', 'c1', 'u1', 'alice', 'raw', 'text', 0, 1)`
    )
    .run(id);
}

function managementRuntime(): ReturnType<typeof createDashboardManagementRuntime> {
  return createDashboardManagementRuntime({
    client: {
      guilds: { cache: new Map() },
      users: { cache: new Map() },
      channels: {
        cache: new Map(),
        fetch: () => Promise.resolve(null),
      },
    } as never,
    db,
  });
}

describe("dashboard management runtime", () => {
  test("deletes stored messages and their lazy metadata", async () => {
    insertMessage("m1");
    db.raw.prepare(`INSERT INTO message_assets
      (message_id, guild_id, channel_id, source_kind, source_key, kind, filename, created_at)
      VALUES ('m1', 'g1', 'c1', 'attachment', 'a1', 'image', 'image.webp', 1)`).run();

    const result = await managementRuntime().deleteMessages({
      messageIds: ["m1"],
      guildId: "g1",
      channelId: "c1",
    });

    expect(result.deletedMessageIds).toEqual(["m1"]);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM message_assets").get()).toEqual({ count: 0 });
  });
});
