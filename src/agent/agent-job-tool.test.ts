import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database.ts";
import { createAgentJobInspectionTools } from "./agent-job-tool.ts";
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

function enqueue() {
  return store.enqueueImageJob({
    guildId: "g1",
    channelId: "c1",
    requesterId: "u1",
    requesterUsername: "alice",
    sourceMessageId: "m1",
    sourceQuote: "make it moodier",
    prompt: "A moonlit android portrait with silver rain",
    references: [{ type: "asset", assetId: 12 }],
    outputFormat: "webp",
    is4k: false,
  }).job;
}

describe("agent job inspection tools", () => {
  test("lists compact prompt previews and reads exact effective input", async () => {
    const job = enqueue();
    const [listTool, readTool] = createAgentJobInspectionTools({ store });
    if (listTool === undefined || readTool === undefined) throw new Error("expected job tools");

    const listed = await listTool.execute("list", { state: "active" });
    expect(listed.content[0]).toMatchObject({ type: "text" });
    expect(listed.content[0]?.type === "text" && listed.content[0].text).toContain(job.id);
    expect(listed.content[0]?.type === "text" && listed.content[0].text).toContain("moonlit android portrait");

    const read = await readTool.execute("read", { job_id: job.id });
    expect(read.content[0]?.type === "text" && read.content[0].text).toContain("Original effective input:");
    expect(read.content[0]?.type === "text" && read.content[0].text).toContain('"asset_id":12');
    expect(read.content[0]?.type === "text" && read.content[0].text).toContain(job.input.prompt);
  });

  test("persists completed image byte metadata for inspection", async () => {
    const job = enqueue();
    store.start(job.id, undefined, 1_500);
    store.markReady(job.id, {
      actualSize: "1586x992",
      contentType: "image/png",
      byteSize: 1_600_631,
    }, 2_000);
    const [, readTool] = createAgentJobInspectionTools({ store });
    if (readTool === undefined) throw new Error("expected read tool");

    const read = await readTool.execute("read", { job_id: job.id });
    const text = read.content[0]?.type === "text" ? read.content[0].text : "";
    expect(text).toContain('"actualSize":"1586x992"');
    expect(text).toContain('"contentType":"image/png"');
    expect(text).toContain('"byteSize":1600631');
  });

  test("keeps older terminal jobs globally readable", async () => {
    const job = enqueue();
    store.markFailed(job.id, "blocked", 2_000);
    const [, readTool] = createAgentJobInspectionTools({ store });
    if (readTool === undefined) throw new Error("expected read tool");

    const read = await readTool.execute("read", { job_id: job.id });
    expect(read.content[0]?.type === "text" && read.content[0].text).toContain("Error: blocked");
  });

  test("globally dismisses a yielded agent", async () => {
    const job = store.enqueueAgentTask({
      guildId: "other-guild",
      channelId: "other-channel",
      requesterId: "u2",
      requesterUsername: "bob",
      sourceMessageId: "m2",
      sourceQuote: "look elsewhere",
      taskName: "check",
      message: "Check the other guild.",
    });
    store.start(job.id);
    store.markYielded(job.id, { handoff: "Done." });
    const [listTool, , dismissTool] = createAgentJobInspectionTools({ store });
    if (listTool === undefined || dismissTool === undefined) throw new Error("expected job tools");

    const listed = await listTool.execute("list", { state: "active" });
    expect(listed.content[0]?.type === "text" && listed.content[0].text).toContain("origin guild other-guild channel other-channel");
    await dismissTool.execute("dismiss", { job_id: job.id, reason: "No follow-up remains." });

    expect(store.get(job.id)).toMatchObject({ status: "dismissed", cancelReason: "No follow-up remains." });
  });
});
