import { expect, test } from "bun:test";
import { createDatabase } from "../db/database.ts";
import { localMessageIdsInRange } from "./asset-backfill.ts";

test("backfill page range includes missing Discord messages and excludes prior pages", () => {
  const db = createDatabase(":memory:");
  const insert = db.raw.prepare(`INSERT INTO messages
    (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, created_at)
    VALUES (?, 'g', 'c', 'u', 'a', '', '', ?)`);
  insert.run("100", 1);
  insert.run("200", 2);
  insert.run("300", 3);
  expect([...localMessageIdsInRange(db, "c", "301", "150")]).toEqual(["200", "300"]);
  db.close();
});
