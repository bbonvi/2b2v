import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Client, Guild } from "discord.js";
import type { GuildConfig } from "../config/types.ts";
import type { Database } from "../db/database.ts";
import { listInnerThreads, type InnerThread } from "../db/inner-thread-repository.ts";
import { insertPromptOnlyBotMessage } from "../db/message-state-repository.ts";
import { buildMemoryMaintenanceContext } from "./memory-context.ts";
import { buildInnerThreadSweepContext } from "./inner-thread-service.ts";
import { listRelationshipEvents, listRelationshipProfiles, renderRelationshipSweepContext } from "../relationships/index.ts";
import type { MemoryExtractionRequest } from "./turn-types.ts";
import { commitStagedMaintenanceCalls, type SemanticMaintenanceCoordinator, stageMaintenanceTools, type StagedMaintenanceCall } from "./semantic-maintenance-coordinator.ts";

interface SweepTrigger {
  guildConfig: GuildConfig;
  memoryRequest: MemoryExtractionRequest;
  guild: Guild;
  channel: unknown;
  sourceRequestId: string;
  source?: string;
}

interface SweepCursor {
  lastAt: number;
  memoryId: number;
  relationshipOffset: number;
  threadOffset: number;
}

function bounded(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 90))}\n\n[Candidate list truncated at the configured safety limit.]`;
}

function rotate<T>(items: readonly T[], offset: number, limit: number): { items: T[]; nextOffset: number } {
  if (items.length === 0) return { items: [], nextOffset: 0 };
  const start = Math.max(0, offset) % items.length;
  const selected = [...items.slice(start), ...items.slice(0, start)].slice(0, limit);
  return { items: selected, nextOffset: (start + selected.length) % items.length };
}

function appliedCount(details: unknown): number {
  if (details === null || typeof details !== "object" || Array.isArray(details)) return 0;
  const value = details as Record<string, unknown>;
  return typeof value.applied === "number"
    ? value.applied
    : Array.isArray(value.accepted) ? value.accepted.length : 0;
}

/** Create infrequent profile-wide and guild-local semantic corpus sweeps. */
export function createSemanticMaintenanceSweep(input: {
  db: Database;
  client: Client;
  coordinator: SemanticMaintenanceCoordinator;
  profileId: () => string;
  resolvePromptUsername: (guild: Guild, userId: string) => string | undefined;
  createTools: (input: {
    guild: Guild;
    guildConfig: GuildConfig;
    memoryRequest: MemoryExtractionRequest;
    currentUserId: string;
    currentUsername?: string;
    sourceMessageId: string;
    sourceRequestId: string;
    dryRun: boolean;
    relationshipUserId: string;
  }) => AgentTool[];
  runMemoryPass: (input: SweepTrigger & {
    currentUserId: string;
    currentUsername?: string;
    maintenanceTools: AgentTool[];
    passKind: "sweep";
    deferCommit: true;
    memoryContextOverride: string;
    modelProfile: string;
  }) => Promise<unknown>;
  runRelationshipPass: (input: SweepTrigger & {
    currentUserId: string;
    currentUsername?: string;
    maintenanceTools: AgentTool[];
    relationshipStateOverride: string;
    modelProfile: string;
  }) => Promise<void>;
  runInnerThreadPass: (input: Omit<SweepTrigger, "source"> & {
    maintenanceTools: AgentTool[];
    maintenanceContextOverride: string;
    modelProfile: string;
  }) => Promise<void>;
}): (trigger: SweepTrigger) => Promise<void> {
  const profileCursors = new Map<string, SweepCursor>();
  const guildCursors = new Map<string, SweepCursor>();
  const emptyCursor = (): SweepCursor => ({ lastAt: 0, memoryId: 0, relationshipOffset: 0, threadOffset: 0 });

  return async (trigger): Promise<void> => {
    const config = trigger.guildConfig.semanticMaintenance.sweep;
    if (!config.enabled) return;
    const now = Date.now();
    const profileKey = input.profileId();
    const guildKey = `${profileKey}:${trigger.guild.id}`;
    const profile = profileCursors.get(profileKey) ?? emptyCursor();
    const guild = guildCursors.get(guildKey) ?? emptyCursor();
    const profileDue = now - profile.lastAt >= config.everyMs;
    const guildDue = now - guild.lastAt >= config.everyMs;
    if (!profileDue && !guildDue) return;

    const sourceMessageId = trigger.memoryRequest.sourceMessageId
      ?? trigger.memoryRequest.incomingMessage.messageId
      ?? `sweep-${now}`;
    const currentUserId = trigger.memoryRequest.context.memoryFocusUserId
      ?? trigger.memoryRequest.incomingMessage.authorId;
    const currentUsername = input.resolvePromptUsername(trigger.guild, currentUserId)
      ?? trigger.memoryRequest.incomingMessage.authorUsername;
    const createTools = (dryRun: boolean): AgentTool[] => input.createTools({
      guild: trigger.guild,
      guildConfig: trigger.guildConfig,
      memoryRequest: trigger.memoryRequest,
      currentUserId,
      currentUsername,
      sourceMessageId,
      sourceRequestId: trigger.sourceRequestId,
      dryRun,
      relationshipUserId: currentUserId,
    });
    const commitTools = createTools(false);
    const calls: StagedMaintenanceCall[] = [];
    const stagedTools = stageMaintenanceTools(
      createTools(true),
      calls,
      new Set(["record_memory", "record_relationship", "record_inner_threads"]),
    );
    const profileLimit = profileDue && guildDue
      ? Math.ceil(config.memories.maxRows / 2)
      : config.memories.maxRows;
    const guildLimit = profileDue && guildDue
      ? Math.floor(config.memories.maxRows / 2)
      : config.memories.maxRows;
    const profileMemory = profileDue
      ? buildMemoryMaintenanceContext({
          db: input.db,
          guildId: trigger.guild.id,
          afterId: profile.memoryId,
          limit: profileLimit,
          scope: "portable",
          resolveUserId: (userId) => input.resolvePromptUsername(trigger.guild, userId),
        })
      : { text: "", nextCursorId: profile.memoryId };
    const guildMemory = guildDue && guildLimit > 0
      ? buildMemoryMaintenanceContext({
          db: input.db,
          guildId: trigger.guild.id,
          afterId: guild.memoryId,
          limit: guildLimit,
          scope: "guild",
          resolveUserId: (userId) => input.resolvePromptUsername(trigger.guild, userId),
        })
      : { text: "", nextCursorId: guild.memoryId };
    const memoryContext = bounded(
      [profileMemory.text, guildMemory.text].filter((part) => part !== "").join("\n\n"),
      config.memories.maxChars,
    );
    const allProfiles = profileDue ? listRelationshipProfiles(input.db, 500) : [];
    const relationships = rotate(allProfiles, profile.relationshipOffset, config.relationships.maxProfiles);
    const relationshipContext = bounded(renderRelationshipSweepContext(relationships.items.map((item) => ({
      profile: item,
      label: input.resolvePromptUsername(trigger.guild, item.userId) ?? item.userId,
      events: listRelationshipEvents(input.db, { userId: item.userId, limit: 30 }),
    }))), config.relationships.maxChars);
    const threadCandidates = listInnerThreads(input.db, { status: "all", guildId: trigger.guild.id, limit: 10_000 });
    const threadProfileLimit = profileDue && guildDue
      ? Math.ceil(config.innerThreads.maxRows / 2)
      : config.innerThreads.maxRows;
    const threadGuildLimit = profileDue && guildDue
      ? Math.floor(config.innerThreads.maxRows / 2)
      : config.innerThreads.maxRows;
    const profileThreads = rotate<InnerThread>(
      profileDue ? threadCandidates.filter((thread) => thread.recallScope === "anywhere") : [],
      profile.threadOffset,
      threadProfileLimit,
    );
    const guildThreads = rotate<InnerThread>(
      guildDue && threadGuildLimit > 0
        ? threadCandidates.filter((thread) => thread.recallScope === "guild" && thread.recallGuildId === trigger.guild.id)
        : [],
      guild.threadOffset,
      threadGuildLimit,
    );
    const threadContext = bounded(buildInnerThreadSweepContext({
      threads: [...profileThreads.items, ...guildThreads.items],
      currentGuildId: trigger.guild.id,
      resolveUserId: (userId) => input.resolvePromptUsername(trigger.guild, userId),
      resolveGuildId: (guildId) => input.client.guilds.cache.get(guildId)?.name,
    }), config.innerThreads.maxChars);
    const ticket = input.coordinator.reserve();
    try {
      if (memoryContext !== "") {
        await input.runMemoryPass({
          ...trigger,
          currentUserId,
          currentUsername,
          maintenanceTools: stagedTools,
          passKind: "sweep",
          deferCommit: true,
          memoryContextOverride: memoryContext,
          modelProfile: config.modelProfile,
        });
      }
      if (relationshipContext !== "") {
        await input.runRelationshipPass({
          ...trigger,
          currentUserId,
          currentUsername,
          maintenanceTools: stagedTools,
          relationshipStateOverride: relationshipContext,
          modelProfile: config.modelProfile,
        });
      }
      if (threadContext !== "") {
        await input.runInnerThreadPass({
          guildConfig: trigger.guildConfig,
          memoryRequest: trigger.memoryRequest,
          guild: trigger.guild,
          channel: trigger.channel,
          sourceRequestId: trigger.sourceRequestId,
          maintenanceTools: stagedTools,
          maintenanceContextOverride: threadContext,
          modelProfile: config.modelProfile,
        });
      }
      await ticket.commit(async () => {
        const applied = new Map<string, number>();
        await commitStagedMaintenanceCalls({
          calls,
          tools: commitTools,
          onResult: (call, result) => applied.set(
            call.toolName,
            (applied.get(call.toolName) ?? 0) + appliedCount(result.details),
          ),
        });
        if (input.client.user !== null) {
          insertPromptOnlyBotMessage(input.db, {
            id: `prompt-only:maintenance-sweep:${sourceMessageId}:${now}`,
            guildId: trigger.guild.id,
            channelId: trigger.memoryRequest.incomingMessage.channelId ?? "",
            botUserId: input.client.user.id,
            botUsername: input.client.user.username,
            content: `<maintenance-sweep memories="${applied.get("record_memory") ?? 0}" relationships="${applied.get("record_relationship") ?? 0}" inner_threads="${applied.get("record_inner_threads") ?? 0}"/>`,
            replyToId: sourceMessageId,
          });
        }
      });
      if (profileDue) {
        profileCursors.set(profileKey, {
          lastAt: now,
          memoryId: profileMemory.nextCursorId,
          relationshipOffset: relationships.nextOffset,
          threadOffset: profileThreads.nextOffset,
        });
      }
      if (guildDue && (guildLimit > 0 || threadGuildLimit > 0)) {
        guildCursors.set(guildKey, {
          lastAt: now,
          memoryId: guildMemory.nextCursorId,
          relationshipOffset: guild.relationshipOffset,
          threadOffset: guildThreads.nextOffset,
        });
      }
    } catch (error) {
      ticket.skip();
      throw error;
    }
  };
}
