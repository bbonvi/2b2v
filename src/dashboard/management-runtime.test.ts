import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDatabase, type Database } from "../db/database";
import { insertImage } from "../db/image-repository";
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
  test("deletes local image files for deleted stored messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "2b2v-dashboard-delete-"));
    const imagePath = join(dir, "image.webp");
    writeFileSync(imagePath, "image");
    insertMessage("m1");
    insertImage(db, {
      messageId: "m1",
      guildId: "g1",
      channelId: "c1",
      path: imagePath,
      mime: "image/webp",
      width: 1,
      height: 1,
      createdAt: 1,
    });

    const result = await managementRuntime().deleteMessages({
      messageIds: ["m1"],
      guildId: "g1",
      channelId: "c1",
    });

    expect(result.deletedImages).toBe(1);
    expect(existsSync(imagePath)).toBe(false);
  });
});
