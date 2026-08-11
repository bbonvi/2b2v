import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Client, Guild } from "discord.js";
import type { GuildConfig } from "../config/types.ts";
import type { Database } from "../db/database.ts";
import { markMemoryExtractionCheckpointAtMessage } from "../db/memory-extraction-repository.ts";
import { insertPromptOnlyBotMessage } from "../db/message-state-repository.ts";
import { promptLabSyntheticId } from "../dashboard/prompt-lab-runtime.ts";
import type { MemoryExtractionRequest } from "./turn-types.ts";
import { hasMaintenanceMaterial } from "./turn-types.ts";
import { commitStagedMaintenanceCalls, type SemanticMaintenanceCoordinator, stageMaintenanceTools, type StagedMaintenanceCall } from "./semantic-maintenance-coordinator.ts";

interface BurstInput {
  guildConfig: GuildConfig;
  memoryRequest: MemoryExtractionRequest;
  guild: Guild;
  channel: unknown;
  sourceRequestId: string;
  source?: string;
}

type MemoryPass = (input: BurstInput & {
  currentUserId: string;
  currentUsername?: string;
  maintenanceTools: AgentTool[];
  burstContext: true;
  deferCommit: true;
  modelProfile: string;
}) => Promise<unknown>;

type RelationshipPass = (input: BurstInput & {
  currentUserId: string;
  currentUsername?: string;
  maintenanceTools: AgentTool[];
  retrievalFirst: true;
  modelProfile: string;
}) => Promise<void>;

type InnerThreadPass = (input: Omit<BurstInput, "source"> & {
  maintenanceTools: AgentTool[];
  retrievalFirst: true;
  modelProfile: string;
}) => Promise<void>;

const semanticSectionLabels = new Set(["Memories", "Relationships", "Inner Threads"]);

function appliedCount(details: unknown): number {
  if (details === null || typeof details !== "object" || Array.isArray(details)) return 0;
  const value = details as Record<string, unknown>;
  return typeof value.applied === "number"
    ? value.applied
    : Array.isArray(value.accepted) ? value.accepted.length : 0;
}

/** Create the delayed three-pass semantic maintenance burst. */
export function createSemanticMaintenanceBurst(input: {
  db: Database;
  client: Client;
  coordinator: SemanticMaintenanceCoordinator;
  resolvePromptUsername: (guild: Guild, userId: string) => string | undefined;
  markCheckpointFromContext: (input: {
    guildId: string;
    channelId: string;
    contextMessageIds: readonly string[] | undefined;
    fallbackMessageId?: string;
  }) => boolean;
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
  runMemoryPass: MemoryPass;
  runRelationshipPass: RelationshipPass;
  runInnerThreadPass: InnerThreadPass;
  runSweep?: (burst: BurstInput & { memoryRequest: MemoryExtractionRequest }) => Promise<void>;
}): (burst: BurstInput) => Promise<void> {
  const runNow = async (burst: BurstInput): Promise<void> => {
    if (!hasMaintenanceMaterial(burst.memoryRequest)) return;
    const sourceMessageId = burst.memoryRequest.sourceMessageId ?? promptLabSyntheticId();
    const guildId = burst.memoryRequest.incomingMessage.guildId ?? burst.guild.id;
    const channelId = burst.memoryRequest.incomingMessage.channelId ?? "";
    const currentUserId = burst.memoryRequest.context.memoryFocusUserId
      ?? burst.memoryRequest.incomingMessage.authorId;
    const currentUsername = input.resolvePromptUsername(burst.guild, currentUserId)
      ?? burst.memoryRequest.incomingMessage.authorUsername;
    const { promptContext: _promptContext, ...requestWithoutPromptContext } = burst.memoryRequest;
    const request: MemoryExtractionRequest = {
      ...requestWithoutPromptContext,
      context: {
        ...burst.memoryRequest.context,
        sections: burst.memoryRequest.context.sections.filter((section) => !semanticSectionLabels.has(section.label)),
      },
    };
    const createTools = (dryRun: boolean): AgentTool[] => input.createTools({
      guild: burst.guild,
      guildConfig: burst.guildConfig,
      memoryRequest: request,
      currentUserId,
      currentUsername,
      sourceMessageId,
      sourceRequestId: burst.sourceRequestId,
      dryRun,
      relationshipUserId: currentUserId,
    });
    const commitTools = createTools(false);
    const stagedCalls: StagedMaintenanceCall[] = [];
    const stagedTools = stageMaintenanceTools(
      createTools(true),
      stagedCalls,
      new Set(["record_memory", "record_relationship", "record_inner_threads"]),
    );
    const ticket = input.coordinator.reserve();
    try {
      await input.runMemoryPass({
        ...burst,
        memoryRequest: request,
        currentUserId,
        currentUsername,
        maintenanceTools: stagedTools,
        burstContext: true,
        deferCommit: true,
        modelProfile: burst.guildConfig.semanticMaintenance.burst.modelProfile,
      });
      await input.runRelationshipPass({
        ...burst,
        memoryRequest: request,
        currentUserId,
        currentUsername,
        maintenanceTools: stagedTools,
        retrievalFirst: true,
        modelProfile: burst.guildConfig.semanticMaintenance.burst.modelProfile,
      });
      await input.runInnerThreadPass({
        guildConfig: burst.guildConfig,
        memoryRequest: request,
        guild: burst.guild,
        channel: burst.channel,
        sourceRequestId: burst.sourceRequestId,
        maintenanceTools: stagedTools,
        retrievalFirst: true,
        modelProfile: burst.guildConfig.semanticMaintenance.burst.modelProfile,
      });
      await ticket.commit(async () => {
        const applied = new Map<string, number>();
        await commitStagedMaintenanceCalls({
          calls: stagedCalls,
          tools: commitTools,
          onResult: (call, result) => applied.set(
            call.toolName,
            (applied.get(call.toolName) ?? 0) + appliedCount(result.details),
          ),
        });
        if (!markMemoryExtractionCheckpointAtMessage(input.db, { guildId, channelId, messageId: sourceMessageId })) {
          input.markCheckpointFromContext({
            guildId,
            channelId,
            contextMessageIds: request.context.contextMessageIds,
            fallbackMessageId: sourceMessageId,
          });
        }
        if (input.client.user !== null) {
          insertPromptOnlyBotMessage(input.db, {
            id: `prompt-only:maintenance:${sourceMessageId}`,
            guildId,
            channelId,
            botUserId: input.client.user.id,
            botUsername: input.client.user.username,
            content: `<maintenance through="${sourceMessageId}" memories="${applied.get("record_memory") ?? 0}" relationships="${applied.get("record_relationship") ?? 0}" inner_threads="${applied.get("record_inner_threads") ?? 0}"/>`,
            replyToId: sourceMessageId,
          });
        }
      });
      await input.runSweep?.({ ...burst, memoryRequest: request });
    } catch (error) {
      ticket.skip();
      throw error;
    }
  };

  return (burst): Promise<void> => burst.guildConfig.semanticMaintenance.burst.enabled
    ? input.coordinator.scheduleBurst({
        key: `${burst.memoryRequest.incomingMessage.guildId ?? burst.guild.id}:${burst.memoryRequest.incomingMessage.channelId ?? ""}`,
        quietAfterMs: burst.guildConfig.semanticMaintenance.burst.quietAfterMs,
        maxWaitMs: burst.guildConfig.semanticMaintenance.burst.maxWaitMs,
        run: async () => await runNow(burst),
      })
    : runNow(burst);
}
