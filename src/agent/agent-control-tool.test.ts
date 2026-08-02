import { afterEach, beforeEach, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database.ts";
import { AgentJobStore } from "./job-runtime.ts";
import { createAgentControlTools } from "./agent-control-tool.ts";

let db: Database;

beforeEach(() => { db = createDatabase(":memory:"); });
afterEach(() => db.close());

test("spawn_agent starts a durable job and send_agent_message resumes it", async () => {
  const store = new AgentJobStore(db, {
    imageTimeoutMs: 300_000,
    imageCancelGraceMs: 60_000,
    terminalVisibleMs: 600_000,
    yieldedAutoDismissMs: 3_600_000,
    maxImageReplacements: 2,
  });
  const started: string[] = [];
  const [spawn, send] = createAgentControlTools({
    store,
    guildId: "g1",
    channelId: "c1",
    requesterId: "u1",
    requesterUsername: "alice",
    sourceMessageId: "m1",
    sourceQuote: "build it",
    handoffTarget: { kind: "channel", guildId: "g1", channelId: "c1" },
    runAgentJob: (jobId) => {
      started.push(jobId);
      return Promise.resolve();
    },
    trackAgentJob: () => {},
  });
  if (spawn === undefined || send === undefined) throw new Error("Expected agent controls.");

  const spawned = await spawn.execute("spawn", {
    task_name: "build",
    message: "Build the project.",
  });
  const jobId = (spawned.details as { jobId: string }).jobId;
  expect(store.get(jobId)).toMatchObject({ kind: "background_agent", status: "queued" });
  expect((spawn.parameters as { properties?: Record<string, unknown> }).properties?.kind).toBeUndefined();
  store.start(jobId);
  store.finishBackgroundRun(jobId, {
    checkpoint: { transcript: [], activeToolNames: [], loadedSkillIds: [] },
    handoff: "Done.",
    consumedEventIds: [],
  });

  await send.execute("send", { target: jobId, message: "Also run tests." });

  const foreign = store.enqueueBackgroundAgent({
    guildId: "g2",
    channelId: "c2",
    requesterId: "u2",
    requesterUsername: "bob",
    sourceMessageId: "m2",
    sourceQuote: "check elsewhere",
    taskName: "check",
    message: "Check the other guild.",
    handoffTarget: { kind: "channel", guildId: "g2", channelId: "c2" },
  });
  store.start(foreign.id);
  store.finishBackgroundRun(foreign.id, {
    checkpoint: { transcript: [], activeToolNames: [], loadedSkillIds: [] },
    handoff: "Waiting.",
    consumedEventIds: [],
  });
  await send.execute("send-foreign", { target: foreign.id, message: "Continue globally." });

  expect(started).toEqual([jobId, jobId, foreign.id]);
  expect(store.get(jobId)).toMatchObject({ status: "queued" });
  expect(store.get(foreign.id)).toMatchObject({ status: "queued" });
});
