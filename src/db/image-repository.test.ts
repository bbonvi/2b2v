import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createDatabase, type Database } from "./database.ts";
import { insertImage, getImagesByMessageId, getImageById, type ImageRecord } from "./image-repository.ts";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

function tmpDb(): Database {
  return createDatabase(join(tmpdir(), `test-images-${randomUUID()}.db`));
}

describe("image-repository", () => {
  let db: Database;

  beforeEach(() => {
    db = tmpDb();
  });

  afterEach(() => {
    db.close();
  });

  describe("insertImage", () => {
    test("inserts and returns autoincrement ID", () => {
      const rec = insertImage(db, {
        messageId: "msg-1",
        guildId: "g1",
        channelId: "c1",
        path: "/data/g1-c1/images/1.jpg",
        mime: "image/jpeg",
        width: 800,
        height: 600,
        createdAt: 1000,
      });
      expect(rec.id).toBe(1);
      expect(rec.messageId).toBe("msg-1");
      expect(rec.caption).toBeNull();
    });

    test("sequential IDs across inserts", () => {
      const a = insertImage(db, {
        messageId: "msg-1",
        guildId: "g1",
        channelId: "c1",
        path: "/data/1.jpg",
        mime: "image/jpeg",
        width: 100,
        height: 100,
        createdAt: 1000,
      });
      const b = insertImage(db, {
        messageId: "msg-2",
        guildId: "g1",
        channelId: "c1",
        path: "/data/2.jpg",
        mime: "image/jpeg",
        width: 100,
        height: 100,
        createdAt: 2000,
      });
      expect(b.id).toBe(a.id + 1);
    });

    test("stores caption when provided", () => {
      const rec = insertImage(db, {
        messageId: "msg-1",
        guildId: "g1",
        channelId: "c1",
        path: "/data/1.jpg",
        mime: "image/jpeg",
        width: 100,
        height: 100,
        createdAt: 1000,
        caption: "a red car",
      });
      expect(rec.caption).toBe("a red car");
    });

    test("multiple images per message", () => {
      const a = insertImage(db, {
        messageId: "msg-1",
        guildId: "g1",
        channelId: "c1",
        path: "/data/1.jpg",
        mime: "image/jpeg",
        width: 100,
        height: 100,
        createdAt: 1000,
      });
      const b = insertImage(db, {
        messageId: "msg-1",
        guildId: "g1",
        channelId: "c1",
        path: "/data/2.jpg",
        mime: "image/jpeg",
        width: 200,
        height: 150,
        createdAt: 1000,
      });
      expect(a.id).not.toBe(b.id);
      expect(a.messageId).toBe(b.messageId);
    });
  });

  describe("getImagesByMessageId", () => {
    test("returns empty array for unknown message", () => {
      expect(getImagesByMessageId(db, "nonexistent")).toEqual([]);
    });

    test("returns all images for a message ordered by ID", () => {
      insertImage(db, {
        messageId: "msg-1",
        guildId: "g1",
        channelId: "c1",
        path: "/data/2.jpg",
        mime: "image/jpeg",
        width: 200,
        height: 200,
        createdAt: 1000,
      });
      insertImage(db, {
        messageId: "msg-1",
        guildId: "g1",
        channelId: "c1",
        path: "/data/1.jpg",
        mime: "image/jpeg",
        width: 100,
        height: 100,
        createdAt: 1000,
      });
      // Different message — should not appear
      insertImage(db, {
        messageId: "msg-2",
        guildId: "g1",
        channelId: "c1",
        path: "/data/3.jpg",
        mime: "image/jpeg",
        width: 50,
        height: 50,
        createdAt: 2000,
      });

      const results = getImagesByMessageId(db, "msg-1");
      expect(results).toHaveLength(2);
      expect(results[0]?.id).toBeLessThan(results[1]?.id ?? Infinity);
      expect(results[0]?.width).toBe(200);
      expect(results[1]?.width).toBe(100);
    });
  });

  describe("getImageById", () => {
    test("returns null for unknown ID", () => {
      expect(getImageById(db, 999)).toBeNull();
    });

    test("returns image record by ID", () => {
      const inserted = insertImage(db, {
        messageId: "msg-1",
        guildId: "g1",
        channelId: "c1",
        path: "/data/1.jpg",
        mime: "image/jpeg",
        width: 640,
        height: 480,
        createdAt: 5000,
      });
      const found = getImageById(db, inserted.id);
      expect(found).not.toBeNull();
      expect(found).toBeDefined();
      expect(found?.id).toBe(inserted.id);
      expect(found?.width).toBe(640);
      expect(found?.height).toBe(480);
      expect(found?.path).toBe("/data/1.jpg");
    });
  });
});
