import { RequestLog, type Logger } from "../logger";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type requestLogStore } from "../dashboard/store";
import { type loadGlobalConfig } from "../config/loader";
import type { GuildConfig } from "../config/types";
import { channelDisplayName } from "../discord/message-sender";
import { runSilentMemoryAgentPass } from "../agent/maintenance-pass";
import { type IncomingMessage } from "../agent/turn-types";
import { type AssembledContext } from "../agent/context-assembly";
import { type HistoryMessage } from "../agent/history-types";
import { countMessagesSinceMemoryExtraction, getMemoryExtractionCheckpoint, getMessagesSinceMemoryExtraction, markMemoryExtractionCheckpoint, markMemoryExtractionCheckpointAtMessage } from "../db/memory-extraction-repository";
import { formatMessageLine, OLDER_LEGEND } from "../agent/history-formatting";
import { insertDateStamps } from "../agent/history-dates";
import { buildMemoryContext, buildVisibleUserMemoryContext } from "../agent/memory-context";
import { createRecordMemoryTool } from "../agent/memory-extraction";
import { applyRuntimeToolPrompts } from "../agent/runtime-tool-prompts";
import { commitStagedMaintenanceCalls, type SemanticMaintenanceCoordinator, stageMaintenanceTools, type StagedMaintenanceCall } from "../agent/semantic-maintenance-coordinator.ts";
import { dashboardTriggerLocation } from "../dashboard/management-runtime";
import { type PromptBundle } from "../config/instruction-bundle";
import type { Database } from "../db/database";
import { type Client, type Guild, type Message } from "discord.js";

export function createAmbientMemoryRuntime(input: {
    db: Database;
    client: Client;
    log: Logger;
    requestLogStore: typeof requestLogStore;
    getGlobalConfig: () => ReturnType<typeof loadGlobalConfig>;
    getPromptBundle: () => PromptBundle;
    runtimeToolDescription: (toolName: string) => string | undefined;
    resolveKnownUsername: (guild: Guild, username: string) => string | undefined;
    resolvePromptUsername: (guild: Guild, userId: string) => string | undefined;
    semanticMaintenanceCoordinator: SemanticMaintenanceCoordinator;
  }
) {
  const { db, client, log, requestLogStore, getGlobalConfig, getPromptBundle, runtimeToolDescription, resolveKnownUsername, resolvePromptUsername, semanticMaintenanceCoordinator } = input;
const ambientMemoryPasses = new Set<string>();

function collectHumanUserIds(messages: HistoryMessage[]): string[] {
  const recency = new Map<string, true>();
  for (const message of messages) {
    if (message.isBot) continue;
    recency.delete(message.authorId);
    recency.set(message.authorId, true);
  }
  return [...recency.keys()].reverse();
}

function formatAmbientMemoryHistory(messages: HistoryMessage[], timezone: string): string {
  const dateEntries = insertDateStamps(messages, timezone);
  const lines: string[] = [OLDER_LEGEND];
  for (const entry of dateEntries) {
    if (entry.type === "date") {
      lines.push(entry.text);
      continue;
    }
    const item = messages[entry.index];
    if (item === undefined) continue;
    lines.push(formatMessageLine({
      message: item,
      reply: null,
      includeMessageIds: true,
      includeDisplayNames: true,
    }));
  }
  return `## Ambient Chat History\n${lines.join("\n")}`;
}

async function maybeRunAmbientMemoryExtraction(message: Message, guildConfig: GuildConfig): Promise<void> {
  if (!guildConfig.memoryExtraction.ambient.enabled) return;
  if (message.guild === null || message.guildId === null) return;
  if (client.user === null) return;

  const guildId = message.guildId;
  const channelId = message.channelId;
  const key = `${guildId}:${channelId}`;
  if (ambientMemoryPasses.has(key)) return;

  const checkpoint = getMemoryExtractionCheckpoint(db, guildId, channelId);
  const now = Date.now();
  const minIntervalMs = guildConfig.memoryExtraction.ambient.minIntervalSeconds * 1000;
  if (checkpoint !== null && now - checkpoint.lastRunAt < minIntervalMs) return;

  const pendingCount = countMessagesSinceMemoryExtraction(db, {
    guildId,
    channelId,
    checkpoint,
  });
  if (pendingCount < guildConfig.memoryExtraction.ambient.everyMessages) return;

  const batch = getMessagesSinceMemoryExtraction(db, {
    guildId,
    channelId,
    checkpoint,
    limit: guildConfig.memoryExtraction.ambient.maxBatchMessages,
  });
  const lastMessage = batch[batch.length - 1];
  if (lastMessage === undefined) return;

  ambientMemoryPasses.add(key);
  try {
    const guild = message.guild;
    const memoryLog = new RequestLog(guildId, channelId, requestLogStore);
    memoryLog.setAuthor("ambient");
    memoryLog.setTriggerContext({
      ...dashboardTriggerLocation(guild, message.channel),
      messageId: message.id,
      authorUsername: message.author.username,
      content: message.content,
    });
    memoryLog.setTrigger({ type: "background_memory_extraction", mode: "ambient" });
    memoryLog.setAgentRan(true);
    requestLogStore.incrementActive();

    const visibleUserIds = collectHumanUserIds(batch);
    const visibleUserMemoryContext = buildVisibleUserMemoryContext({
      db,
      guildId,
      currentUserId: lastMessage.authorId,
      visibleUserIds,
      resolveUserId: (userId) => resolvePromptUsername(guild, userId),
      contextInstruction: getPromptBundle().runtime.contextTemplates["memory-other-visible-users"],
    });
    const currentUserMemories = buildMemoryContext({
      db,
      guildId,
      currentUserId: lastMessage.authorId,
      limit: guildConfig.memoryContext?.maxRows ?? 80,
      resolveUserId: (userId) => resolvePromptUsername(guild, userId),
      contextInstruction: getPromptBundle().runtime.contextTemplates.memory,
    });
    const context: AssembledContext = {
      sections: [
        ...(currentUserMemories !== ""
          ? [{ label: "Memories", role: "developer" as const, cached: false, text: `## Memory\n${currentUserMemories}` }]
          : []),
        {
          label: "Chat History — Newer",
          role: "developer",
          cached: false,
          text: formatAmbientMemoryHistory(batch, guildConfig.timezone),
        },
      ],
      userMessage: "",
      contextMessageIds: batch.map((item) => item.id),
      visibleUserIds,
    };
    const createAmbientRecordMemoryTool = (dryRun: boolean): AgentTool => {
      const unprompted = createRecordMemoryTool({
        db,
        guildId,
        currentUserId: lastMessage.authorId,
        currentUsername: lastMessage.author,
        sourceMessageId: lastMessage.id,
        dryRun,
        recordMemoryDescription: runtimeToolDescription("record_memory"),
        resolveUsername: async (username) => {
          const cached = resolveKnownUsername(guild, username);
          if (cached !== undefined) return cached;
          try {
            await guild.members.fetch();
          } catch {
            // Cache-only fallback below handles missing permissions.
          }
          return resolveKnownUsername(guild, username);
        },
      });
      return applyRuntimeToolPrompts([unprompted], getPromptBundle().runtime)[0] ?? unprompted;
    };
    const validationTool = createAmbientRecordMemoryTool(true);
    const commitTool = createAmbientRecordMemoryTool(false);
    const stagedCalls: StagedMaintenanceCall[] = [];
    const stagedTool = stageMaintenanceTools(
      [validationTool],
      stagedCalls,
      new Set(["record_memory"]),
    )[0];
    if (stagedTool === undefined) throw new Error("Ambient memory staging tool is unavailable.");
    const ticket = semanticMaintenanceCoordinator.reserve();
    const incoming: IncomingMessage = {
      content: "",
      guildId,
      guildName: guild.name,
      channelId,
      channelName: channelDisplayName(message.channel),
      authorId: lastMessage.authorId,
      authorUsername: lastMessage.author,
      authorDisplayName: guild.members.cache.get(lastMessage.authorId)?.displayName,
      authorIsBot: false,
      botUserId: client.user.id,
      mentionedUserIds: [],
      mentionedRoleIds: [],
      botRoleIds: [],
      mentionedEveryone: false,
      translatedContent: "",
      messageId: lastMessage.id,
    };

    try {
      await runSilentMemoryAgentPass({
        globalConfig: getGlobalConfig(),
        guildConfig,
        context,
        systemPrompt: getPromptBundle().systemPrompt,
        personaPrompt: getPromptBundle().corePrompt,
        runtimePrompts: getPromptBundle().runtime,
        incomingMessage: incoming,
        userContent: "",
        assistantReply: "",
        visibleReplySent: false,
        passKind: "ambient",
        visibleUserMemoryContext,
        tools: [stagedTool],
        requestLog: memoryLog,
        log: log.child({ guildId, channelId, requestId: memoryLog.requestId }),
      });
      await ticket.commit(async () => {
        await commitStagedMaintenanceCalls({ calls: stagedCalls, tools: [commitTool] });
        markMemoryExtractionCheckpoint(db, {
          guildId,
          channelId,
          lastMessageId: lastMessage.id,
          lastMessageCreatedAt: lastMessage.timestamp,
        });
      });
    } catch (err) {
      ticket.skip();
      memoryLog.setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      memoryLog.emit(log);
      requestLogStore.decrementActive();
    }
  } catch (err) {
    log.warn("ambient memory extraction failed", {
      guildId,
      channelId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    ambientMemoryPasses.delete(key);
  }
}

function markMemoryExtractionCheckpointFromContext(input: {
  guildId: string;
  channelId: string;
  contextMessageIds: readonly string[] | undefined;
  fallbackMessageId?: string;
  maintenanceCursorId?: number;
}): boolean {
  const ids = [
    ...(input.contextMessageIds ?? []),
    ...(input.fallbackMessageId !== undefined ? [input.fallbackMessageId] : []),
  ];
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const id = ids[i];
    if (id === undefined) continue;
    if (markMemoryExtractionCheckpointAtMessage(db, {
      guildId: input.guildId,
      channelId: input.channelId,
      messageId: id,
      maintenanceCursorId: input.maintenanceCursorId,
    })) {
      return true;
    }
  }
  return false;
}

// --- 20. Build agent tools for a message context ---

  return { maybeRunAmbientMemoryExtraction, markMemoryExtractionCheckpointFromContext };
}
