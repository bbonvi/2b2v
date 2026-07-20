import { describe, expect, test } from "bun:test";
import { createDatabase } from "./database";
import {
  countMessagesSinceMemoryExtraction,
  getMemoryExtractionCheckpoint,
  getMessagesSinceMemoryExtraction,
  markMemoryExtractionCheckpoint,
  markMemoryExtractionCheckpointAtMessage,
} from "./memory-extraction-repository";

function insertMessage(db: ReturnType<typeof createDatabase>, id: string, createdAt: number, overrides: Partial<{
  guildId: string;
  channelId: string;
  userId: string;
  content: string;
  isBot: number;
  isSynthetic: number;
}> = {}): void {
  db.raw
    .prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, is_synthetic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      overrides.guildId ?? "g1",
      overrides.channelId ?? "c1",
      overrides.userId ?? `u-${id}`,
      `user-${id}`,
      overrides.content ?? `raw-${id}`,
      overrides.content ?? `content-${id}`,
      overrides.isBot ?? 0,
      createdAt,
      overrides.isSynthetic ?? 0,
    );
}

describe("memory extraction checkpoints", () => {
  test("counts and fetches human messages after the checkpoint", () => {
    const db = createDatabase(":memory:");
    try {
      insertMessage(db, "m1", 1000);
      insertMessage(db, "m2", 2000);
      insertMessage(db, "bot", 3000, { isBot: 1 });
      insertMessage(db, "synthetic", 4000, { isSynthetic: 1 });
      insertMessage(db, "m3", 5000);

      expect(markMemoryExtractionCheckpointAtMessage(db, {
        guildId: "g1",
        channelId: "c1",
        messageId: "m1",
        now: 10_000,
      })).toBe(true);

      const checkpoint = getMemoryExtractionCheckpoint(db, "g1", "c1");
      expect(checkpoint?.lastMessageId).toBe("m1");
      expect(checkpoint?.lastRunAt).toBe(10_000);
      expect(checkpoint?.maintenanceCursorId).toBe(0);
      expect(countMessagesSinceMemoryExtraction(db, { guildId: "g1", channelId: "c1", checkpoint })).toBe(2);
      expect(getMessagesSinceMemoryExtraction(db, {
        guildId: "g1",
        channelId: "c1",
        checkpoint,
        limit: 10,
      }).map((message) => message.id)).toEqual(["m2", "m3"]);
    } finally {
      db.close();
    }
  });

  test("advances the maintenance cursor only when explicitly supplied", () => {
    const db = createDatabase(":memory:");
    try {
      insertMessage(db, "m1", 1000);
      markMemoryExtractionCheckpoint(db, {
        guildId: "g1",
        channelId: "c1",
        lastMessageId: "m1",
        lastMessageCreatedAt: 1000,
        maintenanceCursorId: 42,
      });
      markMemoryExtractionCheckpoint(db, {
        guildId: "g1",
        channelId: "c1",
        lastMessageId: "m1",
        lastMessageCreatedAt: 1000,
      });
      expect(getMemoryExtractionCheckpoint(db, "g1", "c1")?.maintenanceCursorId).toBe(42);

      expect(markMemoryExtractionCheckpointAtMessage(db, {
        guildId: "g1",
        channelId: "c1",
        messageId: "m1",
        maintenanceCursorId: 84,
      })).toBe(true);
      expect(getMemoryExtractionCheckpoint(db, "g1", "c1")?.maintenanceCursorId).toBe(84);
    } finally {
      db.close();
    }
  });
});
