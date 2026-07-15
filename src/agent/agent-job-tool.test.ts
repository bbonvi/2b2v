import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database.ts";
import { createAgentJobInspectionTools } from "./agent-job-tool.ts";
import { AgentJobStore } from "./job-runtime.ts";

const config = {
  imageTimeoutMs: 300_000,
  imageCancelGraceMs: 60_000,
  terminalVisibleMs: 600_000,
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
    const [listTool, readTool] = createAgentJobInspectionTools({ store, guildId: "g1", channelId: "c1" });
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

  test("keeps older terminal jobs readable but rejects another channel", async () => {
    const job = enqueue();
    store.markFailed(job.id, "blocked", 2_000);
    const [, readHere] = createAgentJobInspectionTools({ store, guildId: "g1", channelId: "c1" });
    const [, readElsewhere] = createAgentJobInspectionTools({ store, guildId: "g1", channelId: "c2" });
    if (readHere === undefined || readElsewhere === undefined) throw new Error("expected read tools");

    const read = await readHere.execute("read", { job_id: job.id });
    expect(read.content[0]?.type === "text" && read.content[0].text).toContain("Error: blocked");
    expect(() => readElsewhere.execute("read", { job_id: job.id })).toThrow("not found or is not visible");
  });
});
