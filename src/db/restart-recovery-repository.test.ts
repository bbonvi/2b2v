import { describe, expect, test } from "bun:test";
import { createDatabase } from "./database";
import {
  clearRestartRecoveryState,
  getRestartRecoveryState,
  listRecentDiscordChannels,
  setRestartRecoveryCutoff,
} from "./restart-recovery-repository";

describe("restart recovery repository", () => {
  test("stores one replaceable cutoff", () => {
    const db = createDatabase(":memory:");
    try {
      setRestartRecoveryCutoff(db, 1_000);
      setRestartRecoveryCutoff(db, 2_000);

      expect(getRestartRecoveryState(db)).toEqual({ cutoffAt: 2_000, createdAt: 2_000 });
      clearRestartRecoveryState(db);
      expect(getRestartRecoveryState(db)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("lists recent real Discord channels by activity", () => {
    const db = createDatabase(":memory:");
    try {
      const insert = db.raw.prepare(`INSERT INTO messages
        (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, is_synthetic, is_prompt_only)
        VALUES (?, 'g', ?, 'u', 'user', 'x', 'x', 0, ?, ?, ?)`);
      insert.run("100", "older", 100, 0, 0);
      insert.run("200", "newer", 200, 0, 0);
      insert.run("synthetic", "ignored", 300, 1, 0);
      insert.run("prompt-only", "ignored", 400, 0, 1);

      expect(listRecentDiscordChannels(db, 1)).toEqual([
        { guildId: "g", channelId: "newer", lastActivityAt: 200 },
      ]);
    } finally {
      db.close();
    }
  });
});
