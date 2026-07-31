import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Collection } from "discord.js";
import { createDatabase, type Database } from "../db/database";
import { createInnerThread, getInnerThread } from "../db/inner-thread-repository";
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
      about: "self",
      recallIn: "anywhere",
      recallWhen: ["u9"],
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
      about: "community",
      recallIn: { guildId: "g1" },
      recallWhen: "always",
      kind: "note",
      content: "initial",
      confidence: 0.7,
      priority: 0,
    }).memory;

    const edited = runtime.editMemory({
      memoryId: created.id,
      about: "user",
      recallIn: "anywhere",
      aboutUserId: "u1",
      recallWhen: ["u2", "u3"],
      kind: "preference",
      content: "updated",
      sourceMessageId: "m1",
      provenance: { source: "dashboard" },
      confidence: 0.95,
      priority: 3,
      importantUntil: 9_999_999_999_998,
      expiresAt: 9_999_999_999_999,
    }).memory;

    expect(edited).toMatchObject({
      about: "user",
      recallIn: "anywhere",
      aboutUserId: "u1",
      aboutUsername: "alice",
      recallWhen: ["u2", "u3"],
      recallWhenUsernames: ["bob", "carol"],
      kind: "preference",
      content: "updated",
      sourceMessageId: "m1",
      sourceGuildId: "g1",
      sourceChannelId: "c1",
      provenance: { source: "dashboard" },
      confidence: 0.95,
      priority: 3,
      importantUntil: 9_999_999_999_998,
    });
  });

  test("restores soft-deleted memories", () => {
    const runtime = managementRuntime();
    const memoryId = runtime.createMemory({
      about: "self",
      recallIn: "anywhere",
      recallWhen: "always",
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

  test("creates, edits, shelves, trashes, and restores notebooks", () => {
    const runtime = managementRuntime();
    const created = runtime.createNotebook({
      title: "Dashboard notebook",
      content: "first",
      shelfAfterMs: 2 * 24 * 60 * 60 * 1000,
    }).notebook;
    const edited = runtime.editNotebook({
      notebookId: created.id,
      expectedRevision: created.revision,
      title: "Renamed notebook",
      content: "second",
      shelfAfterMs: created.shelfAfterMs,
    }).notebook;
    const shelved = runtime.setNotebookState({
      notebookId: edited.id,
      expectedRevision: edited.revision,
      targetState: "shelved",
    }).notebook;
    const trashed = runtime.deleteNotebook({
      notebookId: shelved.id,
      expectedRevision: shelved.revision,
    }).notebook;
    const restored = runtime.setNotebookState({
      notebookId: trashed.id,
      expectedRevision: trashed.revision,
      targetState: "active",
    }).notebook;

    expect(restored).toMatchObject({
      id: created.id,
      title: "Renamed notebook",
      content: "second",
      state: "active",
      revision: 5,
    });
    expect(runtime.listNotebooks().notebooks.map((notebook) => notebook.id)).toEqual([created.id]);
  });

  test("deletes an inner thread", () => {
    const thread = createInnerThread(db, {
      content: "unfinished",
      aboutType: "self",
      recallScope: "anywhere",
      recallMode: "always",
      salience: 0.5,
      pressure: 0.5,
    });

    expect(managementRuntime().deleteInnerThread(thread.id)).toEqual({ deleted: true, threadId: thread.id });
    expect(getInnerThread(db, thread.id)).toBeNull();
  });
});
