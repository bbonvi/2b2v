import { afterEach, expect, test } from "bun:test";
import type { Message } from "discord.js";
import type { PromptBundle } from "../config/instruction-bundle.ts";
import { createDatabase } from "../db/database.ts";
import { AgentJobStore } from "../agent/job-runtime.ts";
import type { SendableGuildChannel } from "./message-sender.ts";
import { createBackgroundHandoffRunner } from "./background-handoff-runtime.ts";

const db = createDatabase(":memory:");
afterEach(() => db.close());

test("hands a yielded job to a fresh actor with its loaded skill grants", async () => {
  const jobs = new AgentJobStore(db, {
    imageTimeoutMs: 300_000,
    imageCancelGraceMs: 60_000,
    terminalVisibleMs: 900_000,
    yieldedAutoDismissMs: 3_600_000,
    maxImageReplacements: 2,
  });
  const job = jobs.enqueueBackgroundAgent({
    guildId: "g1",
    channelId: "c1",
    requesterId: "u1",
    requesterUsername: "alice",
    sourceMessageId: "m1",
    sourceQuote: "do it",
    taskName: "inspect",
    message: "Inspect the workspace.",
    handoffTarget: { kind: "private_life", guildId: "g1", channelId: "c1", episodeId: "episode-1" },
  });
  jobs.start(job.id);
  jobs.finishBackgroundRun(job.id, {
    checkpoint: { transcript: [], activeToolNames: ["workspace_exec"], loadedSkillIds: ["workspace"] },
    handoff: "Inspection complete.",
    consumedEventIds: [],
  });

  type RunnerInput = Parameters<typeof createBackgroundHandoffRunner>[0];
  let turn: Parameters<RunnerInput["runActorTurn"]>[1] | undefined;
  const run = createBackgroundHandoffRunner({
    agentJobs: jobs,
    getPromptBundle: () => ({
      runtime: {
        skills: {
          byId: { workspace: { requiredForTools: ["workspace_exec"] } },
        },
      },
    }) as unknown as PromptBundle,
    fetchAccessibleGuildChannel: () => Promise.resolve({ guildId: "g1" } as SendableGuildChannel),
    enqueueChannelTask: async (_guildId, _channelId, task) => { await task(); },
    createCarrier: () => ({ id: "carrier" }) as Message,
    runActorTurn: (_carrier, options) => {
      turn = options;
      return Promise.resolve({ coveredMessageIds: [options.currentTurnOverride.messageId] });
    },
  });

  await run(job.id);

  expect(turn?.actorSurface).toBe("private-life");
  expect(turn?.preloadedSkillIds).toEqual(["workspace"]);
  expect(turn?.initialToolNames).toEqual([
    "read_agent_job",
    "send_agent_message",
    "dismiss_agent_job",
    "workspace_exec",
  ]);
  expect(turn?.currentTurnOverride.content).toContain("Inspection complete.");
  expect(jobs.get(job.id)?.handoffNotifiedAt).toBeNumber();
});
