import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database.ts";
import { getHistoryMessagesByIds } from "../db/message-history-repository.ts";
import { AgentJobStore } from "./job-runtime.ts";

const config = {
  imageTimeoutMs: 300_000,
  imageCancelGraceMs: 60_000,
  terminalVisibleMs: 600_000,
  yieldedAutoDismissMs: 3_600_000,
  maxImageReplacements: 2,
};

let db: Database;
let store: AgentJobStore;

beforeEach(() => {
  db = createDatabase(":memory:");
  store = new AgentJobStore(db, config);
});
afterEach(() => db.close());

function enqueueImage(overrides: Partial<Parameters<AgentJobStore["enqueueImageJob"]>[0]> = {}) {
  return store.enqueueImageJob({
    guildId: "g1",
    channelId: "c1",
    requesterId: "u1",
    requesterUsername: "alice",
    sourceMessageId: "m1",
    sourceQuote: "make an image",
    prompt: "make an image",
    references: [],
    outputFormat: "png",
    is4k: false,
    ...overrides,
  });
}

function enqueueAgent(overrides: Partial<Parameters<AgentJobStore["enqueueBackgroundAgent"]>[0]> = {}) {
  return store.enqueueBackgroundAgent({
    guildId: "g1",
    channelId: "c1",
    requesterId: "u1",
    requesterUsername: "alice",
    sourceMessageId: "m1",
    sourceQuote: "do it",
    taskName: "build",
    message: "Build the project.",
    handoffTarget: { kind: "channel", guildId: "g1", channelId: "c1" },
    ...overrides,
  });
}

function finishAgent(jobId: string, handoff = "Done.", consumedEventIds: number[] = []) {
  return store.finishBackgroundRun(jobId, {
    checkpoint: { transcript: [], activeToolNames: ["search_tools"], loadedSkillIds: [] },
    handoff,
    consumedEventIds,
  });
}

describe("AgentJobStore", () => {
  test("allows independent image jobs and preserves source and delivery", () => {
    const first = enqueueImage({
      guildId: "source-guild",
      channelId: "source-channel",
      deliveryGuildId: "delivery-guild",
      deliveryChannelId: "thread-channel",
      now: 1,
    }).job;
    const second = enqueueImage({ prompt: "another image", now: 2 }).job;

    expect(second.id).not.toBe(first.id);
    expect(store.listVisible("source-guild", "source-channel")).toHaveLength(1);
    expect(store.listVisible("delivery-guild", "thread-channel")).toHaveLength(1);
    expect(store.listGlobalVisible().map((job) => job.id)).toEqual([first.id, second.id]);
  });

  test("lists image jobs from one generation run in request order", () => {
    const second = enqueueImage({
      prompt: "second",
      generationRunId: "run-1",
      generationIndex: 2,
      now: 1,
    }).job;
    const first = enqueueImage({
      prompt: "first",
      generationRunId: "run-1",
      generationIndex: 1,
      now: 2,
    }).job;
    enqueueImage({
      prompt: "unrelated",
      generationRunId: "run-2",
      generationIndex: 1,
      now: 3,
    });

    expect(store.listImageGenerationRun("run-1").map((job) => job.id)).toEqual([first.id, second.id]);
  });

  test("atomically replaces a fresh image job and rejects a stale replacement", () => {
    const fresh = enqueueImage({ now: 1_000 }).job;
    store.start(fresh.id, undefined, 1_000);
    const replacement = enqueueImage({ replacesJobId: fresh.id, now: 10_000 });

    expect(replacement.created).toBe(true);
    expect(store.get(fresh.id)).toMatchObject({ status: "dismissed", cancelReason: `Replaced by ${replacement.job.id}.` });

    store.start(replacement.job.id, undefined, 10_000);
    const stale = enqueueImage({ replacesJobId: replacement.job.id, now: 80_001 });
    expect(stale).toMatchObject({ created: false, reason: "replacement_too_old", job: { id: replacement.job.id } });
    expect(store.get(replacement.job.id)?.status).toBe("running");
  });

  test("returns ordered asset history at the replacement limit", () => {
    const assetIds: number[] = [];
    for (const [index, messageId] of ["source", "root", "revision-1", "revision-2"].entries()) {
      db.raw.prepare(`INSERT INTO messages
        (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
        VALUES (?, 'g1', 'c1', 'user', 'alice', '', '', 0, ?)`).run(messageId, index + 1);
      db.raw.prepare(`INSERT INTO message_assets
        (message_id, guild_id, channel_id, source_kind, source_key, kind, filename, created_at)
        VALUES (?, 'g1', 'c1', 'attachment', ?, 'image', 'image.webp', ?)`).run(messageId, `asset-${index}`, index + 1);
      assetIds.push((db.raw.prepare("SELECT id FROM message_assets WHERE message_id = ?").get(messageId) as { id: number }).id);
    }
    const [source, rootAsset, firstAsset, secondAsset] = assetIds as [number, number, number, number];
    const root = enqueueImage({ references: [{ type: "asset", assetId: source }] }).job;
    store.linkAsset(root.id, rootAsset);
    const first = enqueueImage({ references: [{ type: "asset", assetId: rootAsset }], replacesJobId: root.id }).job;
    store.linkAsset(first.id, firstAsset);
    const second = enqueueImage({ references: [{ type: "asset", assetId: firstAsset }], replacesJobId: first.id }).job;
    store.linkAsset(second.id, secondAsset);

    expect(enqueueImage({ references: [{ type: "asset", assetId: secondAsset }], replacesJobId: second.id })).toMatchObject({
      created: false,
      reason: "replacement_limit",
      assetHistory: [source, rootAsset, firstAsset, secondAsset],
    });
  });

  test("keeps terminal jobs durable after prompt visibility expires", () => {
    const job = enqueueImage({ now: 1_000 }).job;
    store.markFailed(job.id, "failed", 2_000);

    expect(store.listVisible("g1", "c1", 2_001 + config.terminalVisibleMs)).toHaveLength(0);
    expect(store.get(job.id)?.status).toBe("failed");
    expect(store.list("g1", "c1", "terminal")).toHaveLength(1);
  });

  test("requeues work interrupted by a process restart", () => {
    const job = enqueueAgent({ now: 1_000 });
    store.start(job.id, undefined, 1_100);

    const restarted = new AgentJobStore(db, config);
    const recovered = restarted.get(job.id);
    expect(recovered?.status).toBe("queued");
    expect(recovered !== undefined && "startedAt" in recovered).toBe(false);
  });

  test("recovers each ready image notification only once", () => {
    const job = enqueueImage({ now: 1_000 }).job;
    expect(store.listRecoverableImageJobIds()).toEqual([job.id]);

    store.start(job.id, undefined, 1_500);
    const ready = store.markReady(job.id, { filename: "generated.webp" }, 2_000);
    expect(ready).toMatchObject({ status: "ready", readyNotificationPending: true });
    expect(store.listRecoverableImageJobIds()).toEqual([job.id]);

    expect(store.markReadyNotificationHandled(job.id, 1_999)).toBe(false);
    expect(store.markReadyNotificationHandled(job.id, 2_000)).toBe(true);
    expect(store.get(job.id)).toMatchObject({ status: "ready", readyNotificationPending: false });
    expect(store.listRecoverableImageJobIds()).toEqual([]);

    const restarted = new AgentJobStore(db, config);
    expect(restarted.listRecoverableImageJobIds()).toEqual([]);
  });

  test("persists follow-ups and resumes a yielded background agent", () => {
    const job = enqueueAgent();
    store.start(job.id);
    finishAgent(job.id);

    const resumed = store.sendAgentMessage(job.id, "Run the tests too.");
    expect(resumed).toMatchObject({ shouldRun: true, job: { status: "queued" } });
    expect(store.pendingEvents(job.id).map((event) => event.message)).toEqual([{ kind: "text", text: "Run the tests too." }]);
  });

  test("wakes a waiting parent on every child image result", () => {
    const parent = enqueueAgent();
    store.start(parent.id);
    const first = enqueueImage({ parentJobId: parent.id }).job;
    const second = enqueueImage({ parentJobId: parent.id }).job;
    store.start(first.id);
    store.start(second.id);
    expect(finishAgent(parent.id).job?.status).toBe("waiting_on_jobs");

    store.markReady(first.id, { stagedAssetRef: "one", workspacePath: "/workspace/one.png", contentType: "image/png" });
    expect(store.publishChildResult(first.id)).toEqual({ parentJobId: parent.id, shouldRun: true });
    expect(store.pendingEvents(parent.id)[0]?.message).toMatchObject({ kind: "image_result", childJobId: first.id });

    store.start(parent.id);
    const firstEventIds = store.pendingEvents(parent.id).map((event) => event.id);
    expect(finishAgent(parent.id, "Waiting for the second.", firstEventIds).job?.status).toBe("waiting_on_jobs");
    store.markReady(second.id, { stagedAssetRef: "two", workspacePath: "/workspace/two.png", contentType: "image/png" });
    expect(store.publishChildResult(second.id)).toEqual({ parentJobId: parent.id, shouldRun: true });
    expect(store.listChildren(parent.id).map((job) => job.status)).toEqual(["completed", "completed"]);
  });

  test("cancels unfinished child jobs with their parent", () => {
    const parent = enqueueAgent();
    store.start(parent.id);
    const child = enqueueImage({ parentJobId: parent.id }).job;
    store.start(child.id);

    expect(store.cancel(parent.id, "obsolete").ok).toBe(true);
    expect(store.get(child.id)).toMatchObject({ status: "dismissed", cancelReason: `Parent agent ${parent.id} was cancelled.` });
  });

  test("publishes a cancelled child result to a waiting parent", () => {
    const parent = enqueueAgent();
    store.start(parent.id);
    const child = enqueueImage({ parentJobId: parent.id }).job;
    store.start(child.id);
    finishAgent(parent.id, "Waiting.");
    store.cancel(child.id, "variant no longer needed");

    expect(store.publishChildResult(child.id)).toEqual({ parentJobId: parent.id, shouldRun: true });
    expect(store.pendingEvents(parent.id)[0]?.message).toMatchObject({ kind: "text" });
  });

  test("auto-dismisses only notified yielded agents after the configured delay", () => {
    const job = enqueueAgent({ now: 1_000 });
    store.start(job.id, undefined, 1_500);
    finishAgent(job.id);
    const yielded = store.get(job.id);
    if (yielded === undefined) throw new Error("Expected yielded job.");

    expect(store.dismissStaleYielded(4_000_000)).toBe(0);
    store.markNotificationDelivered(job.id, yielded.statusChangedAt, 3_000);
    expect(store.dismissStaleYielded(3_000 + config.yieldedAutoDismissMs - 1)).toBe(0);
    expect(store.dismissStaleYielded(3_000 + config.yieldedAutoDismissMs)).toBe(1);
    expect(store.get(job.id)).toMatchObject({ status: "dismissed", handoffNotifiedAt: 3_000 });
    expect(() => store.sendAgentMessage(job.id, "One more thing.")).toThrow("cannot receive a message");
  });

  test("persists generated asset provenance across store instances", () => {
    const job = enqueueImage().job;
    db.raw.prepare(`INSERT INTO messages
      (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
      VALUES ('sent-1', 'g1', 'c1', 'bot', '2b', '', '', 1, 1)`).run();
    db.raw.prepare(`INSERT INTO message_assets
      (message_id, guild_id, channel_id, source_kind, source_key, kind, filename, created_at)
      VALUES ('sent-1', 'g1', 'c1', 'attachment', 'discord-asset', 'image', 'generated.webp', 1)`).run();
    const assetId = (db.raw.prepare("SELECT id FROM message_assets WHERE message_id = 'sent-1'").get() as { id: number }).id;
    store.linkAsset(job.id, assetId);
    store.start(job.id, undefined, 1_500);
    store.markReady(job.id, { filename: "generated.webp" }, 1_900);
    store.markDelivered(job.id, "sent-1", { filename: "generated.webp" }, 2_000);

    const restarted = new AgentJobStore(db, config);
    expect(restarted.getForAsset(assetId)).toMatchObject({ role: "output", job: { id: job.id } });
    expect(getHistoryMessagesByIds(db, ["sent-1"])[0]?.assets?.[0]?.jobId).toBe(job.id);
  });
});
