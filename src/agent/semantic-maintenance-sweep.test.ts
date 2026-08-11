import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Client, Guild } from "discord.js";
import { createDatabase, type Database } from "../db/database.ts";
import { createMemory } from "../db/memory-repository.ts";
import { makeGuildConfig } from "./handler-test-support.ts";
import { SemanticMaintenanceCoordinator } from "./semantic-maintenance-coordinator.ts";
import { createSemanticMaintenanceSweep } from "./semantic-maintenance-sweep.ts";
import type { MemoryExtractionRequest } from "./turn-types.ts";

let db: Database;
beforeEach(() => { db = createDatabase(":memory:"); });
afterEach(() => db.close());

function request(guildId: string): MemoryExtractionRequest {
  return {
    sourceMessageId: `${guildId}-m1`,
    userMessage: "hello",
    assistantReply: "hi",
    recentContext: "history",
    visibleReplySent: true,
    incomingMessage: {
      content: "hello",
      translatedContent: "hello",
      guildId,
      channelId: "c1",
      authorId: "u1",
      authorUsername: "alice",
      authorIsBot: false,
      botUserId: "bot",
      mentionedUserIds: [],
      mentionedRoleIds: [],
      botRoleIds: [],
      mentionedEveryone: false,
    },
    context: { sections: [], userMessage: "hello", visibleUserIds: ["u1"], memoryFocusUserId: "u1" },
  };
}

function noopTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} },
    execute: () => Promise.resolve({ content: [{ type: "text", text: "ok" }], details: {} }),
  };
}

describe("semantic maintenance sweep", () => {
  test("does not repeat portable memory in another guild-local sweep", async () => {
    createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "fact", content: "Portable marker" });
    createMemory(db, { guildId: "g1", kind: "note", content: "Guild one marker" });
    createMemory(db, { guildId: "g2", kind: "note", content: "Guild two marker" });
    const contexts: string[] = [];
    const profiles: string[] = [];
    const run = createSemanticMaintenanceSweep({
      db,
      client: { user: { id: "bot", username: "2B" }, guilds: { cache: new Map() } } as unknown as Client,
      coordinator: new SemanticMaintenanceCoordinator(),
      profileId: () => "2b",
      resolvePromptUsername: (_guild, userId) => userId,
      createTools: () => [noopTool("record_memory"), noopTool("record_relationship"), noopTool("record_inner_threads")],
      runMemoryPass: (input) => {
        contexts.push(input.memoryContextOverride);
        profiles.push(input.modelProfile);
        return Promise.resolve();
      },
      runRelationshipPass: () => Promise.resolve(),
      runInnerThreadPass: () => Promise.resolve(),
    });
    const config = makeGuildConfig().semanticMaintenance;
    const guildConfig = (guildId: string) => makeGuildConfig({
      guildId,
      semanticMaintenance: {
        ...config,
        sweep: { ...config.sweep, everyMs: 60_000, modelProfile: "sweep-profile" },
      },
    });

    await run({
      guildConfig: guildConfig("g1"),
      memoryRequest: request("g1"),
      guild: { id: "g1" } as Guild,
      channel: {},
      sourceRequestId: "r1",
    });
    await run({
      guildConfig: guildConfig("g2"),
      memoryRequest: request("g2"),
      guild: { id: "g2" } as Guild,
      channel: {},
      sourceRequestId: "r2",
    });

    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toContain("Portable marker");
    expect(contexts[0]).toContain("Guild one marker");
    expect(contexts[1]).toContain("Guild two marker");
    expect(contexts[1]).not.toContain("Portable marker");
    expect(profiles).toEqual(["sweep-profile", "sweep-profile"]);
  });
});
