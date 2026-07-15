import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Collection } from "discord.js";
import { createDatabase, type Database } from "../db/database";
import { createDashboardManagementRuntime } from "./management-runtime";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function insertMessage(id: string, userId = "u1", username = "alice"): void {
  db.raw
    .prepare(
      `INSERT INTO messages
         (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
       VALUES (?, 'g1', 'c1', ?, ?, 'raw', 'text', 0, 1)`
    )
    .run(id, userId, username);
}

function managementRuntime(fetchUser: (userId: string) => Promise<{ username: string } | null> = () => Promise.resolve(null)): ReturnType<typeof createDashboardManagementRuntime> {
  return createDashboardManagementRuntime({
    client: {
      guilds: { cache: new Collection() },
      users: { cache: new Collection(), fetch: fetchUser },
      channels: {
        cache: new Collection(),
        fetch: () => Promise.resolve(null),
      },
    } as never,
    db,
  });
}

describe("dashboard management runtime", () => {
  test("uses persisted message usernames when Discord caches are cold", async () => {
    insertMessage("m1");

    expect((await managementRuntime().getDirectory()).users).toContainEqual({ id: "u1", name: "alice" });
  });

  test("resolves uncached memory users through Discord", async () => {
    const runtime = managementRuntime((userId) => Promise.resolve(userId === "u9" ? { username: "remote-user" } : null));
    runtime.createMemory({
      scope: "self",
      appliesTo: ["u9"],
      kind: "fact",
      content: "remote user memory",
      confidence: 0.7,
      priority: 0,
    });

    expect((await runtime.getDirectory()).users).toContainEqual({ id: "u9", name: "remote-user" });
    expect((await runtime.getDirectory()).users).toContainEqual({ id: "u9", name: "remote-user" });
  });

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

  test("creates and fully edits structured memories", () => {
    insertMessage("m1");
    insertMessage("m2", "u2", "bob");
    insertMessage("m3", "u3", "carol");
    const runtime = managementRuntime();
    const created = runtime.createMemory({
      scope: "guild",
      guildId: "g1",
      appliesTo: "all",
      kind: "global_note",
      content: "initial",
      confidence: 0.7,
      priority: 0,
    }).memory;

    const edited = runtime.editMemory({
      memoryId: created.id,
      scope: "user",
      guildId: null,
      subjectUserId: "u1",
      appliesTo: ["u2", "u3"],
      kind: "preference",
      content: "updated",
      sourceMessageId: "m1",
      provenance: { source: "dashboard" },
      confidence: 0.95,
      priority: 3,
      expiresAt: 9_999_999_999_999,
    }).memory;

    expect(edited).toMatchObject({
      scope: "user",
      guildId: null,
      subjectUserId: "u1",
      subjectUsername: "alice",
      appliesTo: ["u2", "u3"],
      appliesToUsernames: ["bob", "carol"],
      kind: "preference",
      content: "updated",
      sourceMessageId: "m1",
      sourceGuildId: "g1",
      sourceChannelId: "c1",
      provenance: { source: "dashboard" },
      confidence: 0.95,
      priority: 3,
    });
  });

  test("restores soft-deleted memories", () => {
    const runtime = managementRuntime();
    const memoryId = runtime.createMemory({
      scope: "self",
      appliesTo: "all",
      kind: "identity",
      content: "recoverable",
      confidence: 0.8,
      priority: 1,
    }).memory.id;

    expect(runtime.deleteMemory(memoryId).deleted).toBe(true);
    expect(runtime.listMemories({ status: "deleted" }).memories.map((memory) => memory.id)).toEqual([memoryId]);
    expect(runtime.restoreMemory(memoryId).memory.deletedAt).toBeNull();
    expect(runtime.listMemories({ status: "active" }).memories.map((memory) => memory.id)).toEqual([memoryId]);
  });
});
