import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Client, Guild } from "discord.js";
import { createDatabase, type Database } from "../db/database.ts";
import { makeGuildConfig } from "./handler-test-support.ts";
import { createSemanticMaintenanceBurst } from "./semantic-maintenance-burst.ts";
import { SemanticMaintenanceCoordinator } from "./semantic-maintenance-coordinator.ts";
import type { MemoryExtractionRequest } from "./turn-types.ts";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  db.raw.prepare(`INSERT INTO messages
    (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
    VALUES ('m1', 'g1', 'c1', 'u1', 'alice', 'hello', 'hello', 0, 1)`).run();
});

afterEach(() => db.close());

function writer(name: string, dryRun: boolean, mutations: string[]): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: (_id, params) => {
      if (!dryRun) mutations.push(`${name}:${JSON.stringify(params)}`);
      const values = params as { actions?: unknown[]; signals?: unknown[] };
      return Promise.resolve({
        content: [{ type: "text", text: dryRun ? "valid" : "applied" }],
        details: { applied: values.actions?.length ?? values.signals?.length ?? 0 },
      });
    },
  };
}

describe("semantic maintenance burst", () => {
  test("removes semantic sections, stages all passes, then writes one receipt", async () => {
    const mutations: string[] = [];
    const seenSections: string[][] = [];
    const seenProfiles: string[] = [];
    const coordinator = new SemanticMaintenanceCoordinator();
    const guildConfig = makeGuildConfig({
      guildId: "g1",
      semanticMaintenance: {
        ...makeGuildConfig().semanticMaintenance,
        burst: { ...makeGuildConfig().semanticMaintenance.burst, enabled: false, modelProfile: "burst-profile" },
      },
    });
    const request: MemoryExtractionRequest = {
      sourceMessageId: "m1",
      userMessage: "hello",
      assistantReply: "hi",
      recentContext: "history",
      visibleReplySent: true,
      incomingMessage: {
        content: "hello",
        guildId: "g1",
        channelId: "c1",
        authorId: "u1",
        authorUsername: "alice",
        authorIsBot: false,
        botUserId: "bot",
        mentionedUserIds: [],
        mentionedRoleIds: [],
        botRoleIds: [],
        mentionedEveryone: false,
        translatedContent: "hello",
      },
      context: {
        sections: [
          { label: "Memories", role: "developer", cached: false, text: "memory" },
          { label: "Relationships", role: "developer", cached: false, text: "relationship" },
          { label: "Inner Threads", role: "developer", cached: false, text: "thread" },
          { label: "Chat History — Newer", role: "developer", cached: false, text: "history" },
        ],
        userMessage: "hello",
        contextMessageIds: ["m1"],
        visibleUserIds: ["u1"],
        memoryFocusUserId: "u1",
      },
    };
    const callWriter = async (tools: AgentTool[], name: string, params: unknown): Promise<void> => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`Missing ${name}`);
      await tool.execute(name, params);
    };
    const run = createSemanticMaintenanceBurst({
      db,
      client: { user: { id: "bot", username: "2B" } } as Client,
      coordinator,
      resolvePromptUsername: () => "alice",
      markCheckpointFromContext: () => true,
      createTools: ({ dryRun }) => [
        writer("record_memory", dryRun, mutations),
        writer("record_relationship", dryRun, mutations),
        writer("record_inner_threads", dryRun, mutations),
      ],
      runMemoryPass: async (input) => {
        seenSections.push(input.memoryRequest.context.sections.map((section) => section.label));
        seenProfiles.push(input.modelProfile);
        await callWriter(input.maintenanceTools, "record_memory", { actions: [{}] });
      },
      runRelationshipPass: async (input) => {
        seenSections.push(input.memoryRequest.context.sections.map((section) => section.label));
        seenProfiles.push(input.modelProfile);
        await callWriter(input.maintenanceTools, "record_relationship", { signals: [{}] });
      },
      runInnerThreadPass: async (input) => {
        seenSections.push(input.memoryRequest.context.sections.map((section) => section.label));
        seenProfiles.push(input.modelProfile);
        await callWriter(input.maintenanceTools, "record_inner_threads", { actions: [{}, {}] });
      },
    });

    await run({
      guildConfig,
      memoryRequest: request,
      guild: { id: "g1" } as Guild,
      channel: {},
      sourceRequestId: "r1",
    });

    expect(seenSections).toEqual([
      ["Chat History — Newer"],
      ["Chat History — Newer"],
      ["Chat History — Newer"],
    ]);
    expect(seenProfiles).toEqual(["burst-profile", "burst-profile", "burst-profile"]);
    expect(mutations).toHaveLength(3);
    const receipt = db.raw.prepare("SELECT translated_content FROM messages WHERE id = 'prompt-only:maintenance:m1'")
      .get() as { translated_content: string } | null;
    expect(receipt?.translated_content).toBe('<maintenance through="m1" memories="1" relationships="1" inner_threads="2"/>');
  });
});
