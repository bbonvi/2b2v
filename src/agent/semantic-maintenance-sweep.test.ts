import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Client, Guild } from "discord.js";
import { createDatabase, type Database } from "../db/database.ts";
import { createMemory } from "../db/memory-repository.ts";
import { getSemanticMaintenanceSweepState, setSemanticMaintenanceSweepState } from "../db/semantic-maintenance-repository.ts";
import { saveRelationshipProfile } from "../relationships/repository.ts";
import { emptyRelationshipProfile } from "../relationships/state.ts";
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

function freshContext() {
  return {
    userMessage: "latest history",
    visibleUserIds: ["u1"],
    memoryFocusUserId: "u1",
    sections: [
      { label: "Memories", text: "fresh automatic memory", cached: false, role: "developer" as const },
      { label: "Relationships", text: "fresh automatic relationship", cached: false, role: "developer" as const },
      { label: "Inner Threads", text: "fresh automatic thread", cached: false, role: "developer" as const },
      { label: "Chat History — Newer", text: "fresh standard history", cached: false, role: "developer" as const },
    ],
  };
}

describe("semantic maintenance sweep", () => {
  test("does not repeat portable memory in another guild-local sweep", async () => {
    createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "fact", content: "Portable marker" });
    createMemory(db, { guildId: "g1", kind: "note", content: "Guild one marker" });
    createMemory(db, { guildId: "g2", kind: "note", content: "Guild two marker" });
    saveRelationshipProfile(db, {
      ...emptyRelationshipProfile("u1", 1),
      notes: ["Relationship marker"],
    });
    const contexts: string[] = [];
    const relationshipContexts: string[] = [];
    const profiles: string[] = [];
    const sources: Array<string | undefined> = [];
    const passRequests: MemoryExtractionRequest[] = [];
    setSemanticMaintenanceSweepState(db, "profile:2b", { lastAt: 0, memoryId: 0, relationshipOffset: 0, threadOffset: 0 });
    setSemanticMaintenanceSweepState(db, "guild:2b:g1", { lastAt: 0, memoryId: 0, relationshipOffset: 0, threadOffset: 0 });
    setSemanticMaintenanceSweepState(db, "guild:2b:g2", { lastAt: 0, memoryId: 0, relationshipOffset: 0, threadOffset: 0 });
    const run = createSemanticMaintenanceSweep({
      db,
      client: { user: { id: "bot", username: "2B" }, guilds: { cache: new Map() } } as unknown as Client,
      coordinator: new SemanticMaintenanceCoordinator(),
      profileId: () => "2b",
      resolvePromptUsername: (_guild, userId) => userId,
      buildContext: () => Promise.resolve(freshContext()),
      createTools: () => [noopTool("record_memory"), noopTool("record_relationship"), noopTool("record_inner_threads")],
      runMemoryPass: (input) => {
        passRequests.push(input.memoryRequest);
        contexts.push(input.memoryContextOverride);
        profiles.push(input.modelProfile);
        sources.push(input.source);
        input.memoryRequest.maintenanceTranscript = [{ role: "assistant", content: "sweep memory result" }];
        return Promise.resolve();
      },
      runRelationshipPass: (input) => {
        passRequests.push(input.memoryRequest);
        relationshipContexts.push(input.relationshipStateOverride);
        return Promise.resolve();
      },
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

    const actorRequest = request("g1");
    actorRequest.context.sections = [
      { label: "Chat History — Newer", text: "old actor history", cached: false, role: "developer" },
    ];
    actorRequest.maintenanceTranscript = [{ role: "assistant", content: "actor transcript" }];
    (actorRequest as unknown as { promptContext: unknown }).promptContext = { actor: true };
    await run({
      guildConfig: guildConfig("g1"),
      memoryRequest: actorRequest,
      guild: { id: "g1" } as Guild,
      channel: {},
      sourceRequestId: "r1",
      source: "post_reply",
    });
    await run({
      guildConfig: guildConfig("g2"),
      memoryRequest: request("g2"),
      guild: { id: "g2" } as Guild,
      channel: {},
      sourceRequestId: "r2",
      source: "sweep",
    });

    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toContain("Portable marker");
    expect(contexts[0]).toContain("Guild one marker");
    expect(contexts[1]).toContain("Guild two marker");
    expect(contexts[1]).not.toContain("Portable marker");
    expect(profiles).toEqual(["sweep-profile", "sweep-profile"]);
    expect(sources).toEqual(["sweep", "sweep"]);
    expect(relationshipContexts).toHaveLength(1);
    expect(relationshipContexts[0]).toContain("@u1 (u1)");
    expect(passRequests[0]).not.toBe(actorRequest);
    expect(passRequests[0]?.promptContext).toBeUndefined();
    expect(passRequests[0]?.assistantReply).toBe("");
    expect(passRequests[0]?.incomingMessage.currentContentInHistory).toBe(true);
    expect(passRequests[0]?.context.sections.map((section) => section.label)).toEqual(["Chat History — Newer"]);
    expect(passRequests[0]?.context.sections[0]?.text).toBe("fresh standard history");
    expect(passRequests[1]).toBe(passRequests[0]);
    expect(passRequests[1]?.maintenanceTranscript).toEqual([{ role: "assistant", content: "sweep memory result" }]);
    expect(actorRequest.maintenanceTranscript).toEqual([{ role: "assistant", content: "actor transcript" }]);
  });

  test("runs a new scope once and persists cadence across runtime recreation", async () => {
    createMemory(db, { guildId: "g1", aboutUserId: "u1", kind: "fact", content: "Portable marker" });
    let runs = 0;
    const createRun = () => createSemanticMaintenanceSweep({
      db,
      client: { user: null, guilds: { cache: new Map() } } as unknown as Client,
      coordinator: new SemanticMaintenanceCoordinator(),
      profileId: () => "2b",
      resolvePromptUsername: (_guild, userId) => userId,
      buildContext: () => Promise.resolve(freshContext()),
      createTools: () => [noopTool("record_memory"), noopTool("record_relationship"), noopTool("record_inner_threads")],
      runMemoryPass: () => { runs += 1; return Promise.resolve(); },
      runRelationshipPass: () => Promise.resolve(),
      runInnerThreadPass: () => Promise.resolve(),
    });
    const guildConfig = makeGuildConfig({
      guildId: "g1",
      semanticMaintenance: {
        ...makeGuildConfig().semanticMaintenance,
        sweep: { ...makeGuildConfig().semanticMaintenance.sweep, everyMs: 60_000 },
      },
    });
    const trigger = {
      guildConfig,
      memoryRequest: request("g1"),
      guild: { id: "g1" } as Guild,
      channel: {},
      sourceRequestId: "r1",
      source: "sweep",
    };

    await createRun()(trigger);
    await createRun()(trigger);
    expect(runs).toBe(1);
    expect(getSemanticMaintenanceSweepState(db, "profile:2b")).not.toBeNull();
    expect(getSemanticMaintenanceSweepState(db, "guild:2b:g1")).not.toBeNull();
  });
});
