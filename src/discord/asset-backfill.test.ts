import { expect, test } from "bun:test";
import type { Client } from "discord.js";
import { createDatabase } from "../db/database.ts";
import { createLogger } from "../logger.ts";
import { backfillMessageAssets, localMessageIdsInRange } from "./asset-backfill.ts";

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

test("asset backfill exits before querying Discord when shutdown already aborted it", async () => {
  const db = createDatabase(":memory:");
  const controller = new AbortController();
  controller.abort();

  await backfillMessageAssets({
    db,
    client: {} as Client,
    logger: createLogger({ level: "error" }),
    signal: controller.signal,
  });

  db.close();
});
