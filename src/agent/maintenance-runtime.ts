import { RequestLog, type Logger } from "../logger";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type requestLogStore } from "../dashboard/store";
import { type loadGlobalConfig } from "../config/loader";
import type { GuildConfig } from "../config/types";
import { type SendableGuildChannel } from "../discord/message-sender";
import { runSilentMemoryAgentPass, runSilentToolAgentPass } from "../agent/maintenance-pass";
import { hasMaintenanceMaterial, type HandlerDeps, type MemoryExtractionRequest } from "../agent/turn-types";
import { markMemoryExtractionCheckpointAtMessage } from "../db/memory-extraction-repository";
import { buildVisibleUserMemoryContext } from "../agent/memory-context";
import { createRecordMemoryTool } from "../agent/memory-extraction";
import { buildInnerThreadMaintenanceContext, createRecordInnerThreadsTool } from "../agent/inner-thread-service";
import { applyRuntimeToolPrompts } from "../agent/runtime-tool-prompts";
import { isReadOnlyTool, isToolAllowedInMaintenance, type MaintenanceWriteToolName } from "../agent/tool-effects.ts";
import { createSearchToolsTool } from "../agent/tool-catalog.ts";
import { createPrivateLifeSummaryTool } from "../private-life/summary-tool.ts";
import { dashboardTriggerLocation } from "../dashboard/management-runtime";
import { promptLabSyntheticId } from "../dashboard/prompt-lab-runtime";
import { createRecordRelationshipTool, getRelationshipProfile, listRelationshipEvents, listRelationshipProfiles, renderRelationshipMaintenanceContext, selectRelationshipAnchorProfiles, selectRelationshipContextProfiles, type RelationshipConfig, type RelationshipContextProfile, type RelationshipMutationResult } from "../relationships";
import { type PromptBundle } from "../config/instruction-bundle";
import type { Database } from "../db/database";
import { type Client, type Guild } from "discord.js";
import type { AgentJobStore } from "./job-runtime";
import { deleteExpiredMemories } from "../db/memory-repository";
import { clearExpiredPrivateLifeThoughts } from "../db/private-life-repository";
import { deleteStagedAsset, listStagedAssets } from "../db/staged-asset-repository";
import { stat } from "fs/promises";
import { resolveStagedPath, unlinkStagedPath } from "./staged-path.ts";

export function createMaintenanceRuntime(input: {
    db: Database;
    client: Client;
    log: Logger;
    agentJobs: AgentJobStore;
    requestLogStore: typeof requestLogStore;
    getGlobalConfig: () => ReturnType<typeof loadGlobalConfig>;
    getPromptBundle: () => PromptBundle;
    getRelationshipConfig: (guildConfig: GuildConfig) => RelationshipConfig;
    innerThreadsEnabled: (guildConfig: GuildConfig) => boolean;
    runtimeToolDescription: (toolName: string) => string | undefined;
    runtimeContextTemplate: (name: string, variables?: Record<string, string | number | boolean | undefined>, fallback?: string) => string;
    resolveKnownUsername: (guild: Guild, username: string) => string | undefined;
    resolvePromptUsername: (guild: Guild, userId: string) => string | undefined;
    markMemoryExtractionCheckpointFromContext: (input: { guildId: string; channelId: string; contextMessageIds: readonly string[] | undefined; fallbackMessageId?: string; maintenanceCursorId?: number }) => boolean;
  }
) {
  const { db, client, log, agentJobs, requestLogStore, getGlobalConfig, getPromptBundle, getRelationshipConfig, innerThreadsEnabled, runtimeToolDescription, runtimeContextTemplate, resolveKnownUsername, resolvePromptUsername, markMemoryExtractionCheckpointFromContext } = input;
function blockToolsExcept(tools: AgentTool[], allowedName: string, passLabel: string): AgentTool[] {
  const allowedNames = new Set([allowedName]);
  return tools.map((tool) => allowedNames.has(tool.name)
    ? tool
    : {
        ...tool,
        execute: (_toolCallId: string, _params: unknown): Promise<AgentToolResult<unknown>> => Promise.resolve({
          content: [{
            type: "text",
            text: allowedName === ""
              ? `Blocked: ${passLabel} cannot use ${tool.name}. record_memory, record_relationship, and record_inner_threads are not available in this mode.`
              : `Blocked: ${passLabel} may only use ${allowedName}. Do not call ${tool.name} in this pass.`,
          }],
          details: { blocked: true, pass: passLabel, allowedTool: allowedName, tool: tool.name },
        }),
	      });
}

const maintenanceToolNames = new Set([
  "record_memory",
  "record_relationship",
  "record_inner_threads",
  "record_private_life_episode",
]);
function latestHumanIdentity(guildId: string, channelId: string): {
  userId: string;
  username: string;
} {
  const latestHuman = db.raw.prepare(
    `SELECT user_id, author_username
     FROM messages
     WHERE guild_id = ? AND channel_id = ? AND is_bot = 0
       AND is_synthetic = 0 AND is_prompt_only = 0
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  ).get(guildId, channelId) as { user_id: string; author_username: string } | null;
  return {
    userId: latestHuman?.user_id ?? client.user?.id ?? "",
    username: latestHuman?.author_username ?? client.user?.username ?? "bot",
  };
}

function toolsForMaintenancePass(
  visibleTools: AgentTool[] | undefined,
  maintenanceTools: AgentTool[],
  allowedWriteNames: MaintenanceWriteToolName | ReadonlySet<MaintenanceWriteToolName>,
  passLabel: string,
): AgentTool[] {
  const visible = visibleTools ?? [];
  const readOnlyTools = visible
    .filter((tool) => tool.name !== "search_tools" && !maintenanceToolNames.has(tool.name) && isReadOnlyTool(tool));
  const unpromptedSearchTool = createSearchToolsTool({
    tools: readOnlyTools,
    skills: getPromptBundle().runtime.skills,
  });
  const promptedSearchTool = applyRuntimeToolPrompts([unpromptedSearchTool], getPromptBundle().runtime)[0]
    ?? unpromptedSearchTool;
  const actorSearchTool = visible.find((tool) => tool.name === "search_tools");
  const searchTool = actorSearchTool === undefined
    ? promptedSearchTool
    : { ...actorSearchTool, execute: promptedSearchTool.execute };
  const blockedTool = (tool: AgentTool): AgentTool => isToolAllowedInMaintenance(tool, allowedWriteNames)
    ? tool
    : {
        ...tool,
        execute: (): Promise<AgentToolResult<unknown>> => Promise.resolve({
          content: [{
            type: "text",
            text: `Blocked: ${passLabel} cannot use ${tool.name}.`,
          }],
          details: { blocked: true, pass: passLabel, tool: tool.name },
        }),
      };
  const byName = new Map<string, AgentTool>();
  for (const tool of visible) {
    const maintenanceTool = tool.name === "search_tools" ? searchTool : tool;
    byName.set(maintenanceTool.name, blockedTool(maintenanceTool));
  }
  for (const tool of applyRuntimeToolPrompts(maintenanceTools, getPromptBundle().runtime)) {
    byName.set(tool.name, blockedTool(tool));
  }
  return [...byName.values()];
}

function promptLabMemoryDryRunTool(tool: AgentTool, dryRuns: Array<{ tool: string; args: unknown }> | undefined): AgentTool {
  if (dryRuns === undefined || tool.name !== "record_memory") return tool;
  return {
    ...tool,
    execute: (toolCallId: string, params: unknown, signal?: AbortSignal): Promise<AgentToolResult<unknown>> => {
      dryRuns.push({ tool: tool.name, args: params });
      return tool.execute(toolCallId, params, signal);
    },
  };
}

function promptLabMaintenanceDryRunTools(
  tools: AgentTool[],
  allowedToolName: MaintenanceWriteToolName,
  dryRuns: Array<{ tool: string; args: unknown }> | undefined,
): AgentTool[] {
  if (dryRuns === undefined) return tools;
  return tools.map((tool) => tool.name === allowedToolName
    ? {
        ...tool,
        execute: async (toolCallId: string, params: unknown, signal?: AbortSignal): Promise<AgentToolResult<unknown>> => {
          dryRuns.push({ tool: tool.name, args: params });
          return await tool.execute(toolCallId, params, signal);
        },
      }
    : tool);
}

function createPostReplyMaintenanceTools(input: {
  guild: Guild;
  guildConfig: GuildConfig;
  memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0];
  currentUserId: string;
  currentUsername?: string;
  sourceMessageId: string;
  dryRun?: boolean;
  dryRuns?: Array<{ tool: string; args: unknown }>;
  /** Null requires each relationship signal to name its own target user. */
  relationshipUserId?: string | null;
  onRelationshipResult?: (result: RelationshipMutationResult, candidates: unknown[]) => void;
  sourceRequestId?: string;
}): AgentTool[] {
  const recordMemoryTool = createRecordMemoryTool({
    db,
    guildId: input.guild.id,
    currentUserId: input.currentUserId,
    currentUsername: input.currentUsername,
    sourceMessageId: input.sourceMessageId,
    dryRun: input.dryRun,
    recordMemoryDescription: runtimeToolDescription("record_memory"),
    resolveUsername: async (username) => {
      const cached = resolveKnownUsername(input.guild, username);
      if (cached !== undefined) return cached;
      try {
        await input.guild.members.fetch();
      } catch {
        // Cache-only fallback below handles missing permissions.
      }
      return resolveKnownUsername(input.guild, username);
    },
  });
  const relationshipsConfig = getRelationshipConfig(input.guildConfig);
  const recordRelationshipTool = createRecordRelationshipTool({
    db,
    config: relationshipsConfig,
    dryRun: input.dryRun,
    description: runtimeToolDescription("record_relationship"),
    scope: {
      guildId: input.memoryRequest.incomingMessage.guildId,
      channelId: input.memoryRequest.incomingMessage.channelId,
      ...(input.relationshipUserId === null
        ? {}
        : { userId: input.relationshipUserId ?? input.memoryRequest.incomingMessage.authorId }),
      sourceMessageId: input.memoryRequest.sourceMessageId,
    },
    onResult: (result, candidates) => input.onRelationshipResult?.(result, candidates),
  });
  const innerThreadTools = innerThreadsEnabled(input.guildConfig)
    ? [createRecordInnerThreadsTool({
        db,
        guildId: input.guild.id,
        channelId: input.memoryRequest.incomingMessage.channelId ?? "",
        requestId: input.sourceRequestId,
        description: runtimeToolDescription("record_inner_threads"),
        dryRun: input.dryRun,
      })]
    : [];
  // The actor filters these maintenance-only tools before schema exposure; later
  // maintenance passes reuse the prompted definitions.
  return applyRuntimeToolPrompts([
    promptLabMemoryDryRunTool(recordMemoryTool, input.dryRuns),
    recordRelationshipTool,
    ...innerThreadTools,
  ], getPromptBundle().runtime);
}

async function runMemoryPostReplyExtraction(input: {
  guildConfig: GuildConfig;
  memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0];
  guild: Guild;
  channel: unknown;
  sourceRequestId: string;
  source?: string;
  passKind?: "post_reply" | "ambient";
  currentUserId: string;
  currentUsername?: string;
  dryRun?: boolean;
  dryRuns?: Array<{ tool: string; args: unknown }>;
  maintenanceTools?: AgentTool[];
}): Promise<{ requestId?: string; enabled: boolean; ran: boolean; error?: string }> {
  if (!input.guildConfig.memoryExtraction.postReply || !hasMaintenanceMaterial(input.memoryRequest)) {
    return { enabled: input.guildConfig.memoryExtraction.postReply, ran: false };
  }
  const guildId = input.memoryRequest.incomingMessage.guildId ?? input.guild.id;
  const channelId = input.memoryRequest.incomingMessage.channelId ?? "";
  const sourceMessageId = input.memoryRequest.sourceMessageId ?? promptLabSyntheticId();
  const memoryLog = new RequestLog(guildId, channelId, requestLogStore);
  memoryLog.setAuthor(input.memoryRequest.incomingMessage.authorUsername);
  memoryLog.setTriggerContext({
    ...dashboardTriggerLocation(input.guild, input.channel),
    messageId: sourceMessageId,
    authorUsername: input.memoryRequest.incomingMessage.authorUsername,
    content: input.memoryRequest.userMessage,
    translatedContent: input.memoryRequest.userMessage,
  });
  memoryLog.setTrigger({
    type: "background_memory_extraction",
    sourceRequestId: input.sourceRequestId,
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.dryRun === true ? { dryRun: true } : {}),
  });
  memoryLog.setAgentRan(true);
  requestLogStore.incrementActive();
  const maintenanceTools = input.maintenanceTools ?? createPostReplyMaintenanceTools({
    guild: input.guild,
    guildConfig: input.guildConfig,
    memoryRequest: input.memoryRequest,
    currentUserId: input.currentUserId,
    currentUsername: input.currentUsername,
    sourceMessageId,
    dryRun: input.dryRun,
    dryRuns: input.dryRuns,
  });
  const visibleUserMemoryContext = buildVisibleUserMemoryContext({
    db,
    guildId,
    currentUserId: input.memoryRequest.context.memoryFocusUserId ?? input.currentUserId,
    visibleUserIds: input.memoryRequest.context.visibleUserIds ?? [],
    resolveUserId: (userId) => resolvePromptUsername(input.guild, userId),
    contextInstruction: getPromptBundle().runtime.contextTemplates["memory-other-visible-users"],
  });
  try {
    await runSilentMemoryAgentPass({
      globalConfig: getGlobalConfig(),
      guildConfig: input.guildConfig,
      context: input.memoryRequest.context,
      systemPrompt: getPromptBundle().systemPrompt,
      personaPrompt: getPromptBundle().corePrompt,
      runtimePrompts: getPromptBundle().runtime,
      incomingMessage: input.memoryRequest.incomingMessage,
      userContent: input.memoryRequest.userMessage,
      assistantReply: input.memoryRequest.assistantReply,
      visibleReplySent: input.memoryRequest.visibleReplySent,
      passKind: input.passKind,
      visibleUserMemoryContext,
      tools: toolsForMaintenancePass(
        input.memoryRequest.availableTools,
        maintenanceTools,
        "record_memory",
        "silent memory pass",
      ),
      transcript: input.memoryRequest.maintenanceTranscript,
      promptContext: input.memoryRequest.promptContext,
      requestLog: memoryLog,
      log: log.child({ guildId, channelId, requestId: memoryLog.requestId, component: "memory-pass" }),
    });
    if (input.dryRun !== true) {
      const checkpointMarked = markMemoryExtractionCheckpointAtMessage(db, {
        guildId,
        channelId,
        messageId: sourceMessageId,
      });
      if (!checkpointMarked) {
        markMemoryExtractionCheckpointFromContext({
          guildId,
          channelId,
          contextMessageIds: input.memoryRequest.context.contextMessageIds,
          fallbackMessageId: input.memoryRequest.sourceMessageId,
        });
      }
    }
    return { requestId: memoryLog.requestId, enabled: true, ran: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    memoryLog.setError(error);
    if (input.dryRun === true) return { requestId: memoryLog.requestId, enabled: true, ran: true, error };
    throw err;
  } finally {
    memoryLog.emit(log);
    requestLogStore.decrementActive();
  }
}

async function runRelationshipPostReplyExtraction(input: {
  guildConfig: GuildConfig;
  memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0];
  requestLog?: RequestLog;
  guild?: Guild;
  channel?: unknown;
  source?: string;
  sourceRequestId?: string;
  dryRun?: boolean;
  currentUserId: string;
  currentUsername?: string;
  dryRuns?: Array<{ tool: string; args: unknown }>;
  onResult?: (result: RelationshipMutationResult, candidates: unknown[]) => void;
  maintenanceTools?: AgentTool[];
  additionalDecisionInstruction?: string;
}): Promise<void> {
  const config = getRelationshipConfig(input.guildConfig);
  if (!config.enabled || !hasMaintenanceMaterial(input.memoryRequest)) return;
  const guildId = input.memoryRequest.incomingMessage.guildId ?? "";
  const channelId = input.memoryRequest.incomingMessage.channelId ?? "";
  const relationshipsLog = input.requestLog ?? new RequestLog(guildId, channelId, requestLogStore);
  if (input.requestLog === undefined) {
    relationshipsLog.setAuthor(input.memoryRequest.incomingMessage.authorUsername);
    relationshipsLog.setTrigger({
      type: "relationships_extraction",
      source: input.source ?? "post_reply",
      ...(input.sourceRequestId !== undefined ? { sourceRequestId: input.sourceRequestId } : {}),
      ...(input.dryRun === true ? { dryRun: true } : {}),
    });
    relationshipsLog.setTriggerContext({
      ...(input.guild !== undefined && input.channel !== undefined ? dashboardTriggerLocation(input.guild, input.channel) : {}),
      messageId: input.memoryRequest.sourceMessageId,
      authorUsername: input.memoryRequest.incomingMessage.authorUsername,
      content: input.memoryRequest.userMessage,
      translatedContent: input.memoryRequest.userMessage,
    });
    relationshipsLog.setAgentRan(true);
    requestLogStore.incrementActive();
  }
  const maintenanceTools = input.maintenanceTools ?? (input.guild === undefined
    ? [createRecordRelationshipTool({
        db,
        config,
        dryRun: input.dryRun,
        description: runtimeToolDescription("record_relationship"),
        scope: {
          guildId: input.memoryRequest.incomingMessage.guildId,
          channelId: input.memoryRequest.incomingMessage.channelId,
          userId: input.memoryRequest.incomingMessage.authorId,
          sourceMessageId: input.memoryRequest.sourceMessageId,
        },
        onResult: (result, candidates) => input.onResult?.(result, candidates),
      })]
    : createPostReplyMaintenanceTools({
        guild: input.guild,
        guildConfig: input.guildConfig,
        memoryRequest: input.memoryRequest,
        currentUserId: input.currentUserId,
        currentUsername: input.currentUsername,
        sourceMessageId: input.memoryRequest.sourceMessageId ?? promptLabSyntheticId(),
        dryRun: input.dryRun,
        dryRuns: input.dryRuns,
        onRelationshipResult: input.onResult,
      }));
  try {
    const relationshipLabel = (userId: string): string => {
      if (userId === input.currentUserId) return `@${input.currentUsername ?? userId} (${userId})`;
      const username = input.guild?.members.cache.get(userId)?.user.username;
      return username === undefined ? userId : `@${username} (${userId})`;
    };
    const selected = selectRelationshipContextProfiles({
      currentUserId: input.currentUserId,
      anchors: selectRelationshipAnchorProfiles(listRelationshipProfiles(db, 500)).map(
        (profile): RelationshipContextProfile => ({
          profile,
          label: relationshipLabel(profile.userId),
          reason: "anchor",
        }),
      ),
      recent: (input.memoryRequest.context.visibleUserIds ?? []).map(
        (userId): RelationshipContextProfile => ({
          profile: getRelationshipProfile(db, userId),
          label: relationshipLabel(userId),
          reason: "recent-chat",
        }),
      ),
    });
    const relationshipState = renderRelationshipMaintenanceContext({
      current: {
        profile: getRelationshipProfile(db, input.currentUserId),
        label: relationshipLabel(input.currentUserId),
        events: listRelationshipEvents(db, { userId: input.currentUserId, limit: 30 }),
      },
      others: [...selected.anchors, ...selected.recent],
    });
    const executionMode = runtimeContextTemplate(
      "relationship-maintenance-execution-mode",
      { maxToolCalls: config.maxToolCalls },
      [
        "## Execution Mode: Relationship Maintenance",
        "Private relationship maintenance is active. Read-only tools are optionally available when they would materially reduce uncertainty; record_relationship is the only state-changing tool available, and relevant relationship state is already supplied.",
        "Submit every useful relationship signal as one complete record_relationship signal list. Retry only if the tool reports an error, and retry only rejected signals.",
      ].join("\n"),
    );
    await runSilentToolAgentPass({
      globalConfig: getGlobalConfig(),
      guildConfig: input.guildConfig,
      context: input.memoryRequest.context,
      systemPrompt: getPromptBundle().systemPrompt,
      personaPrompt: getPromptBundle().corePrompt,
      runtimePrompts: getPromptBundle().runtime,
      incomingMessage: input.memoryRequest.incomingMessage,
      userContent: input.memoryRequest.userMessage,
      assistantReply: input.memoryRequest.assistantReply,
      visibleReplySent: input.memoryRequest.visibleReplySent,
      tools: toolsForMaintenancePass(input.memoryRequest.availableTools, maintenanceTools, "record_relationship", "silent relationships pass"),
      runtimeInstruction: getPromptBundle().runtime.reply,
      controlMessage: [
        executionMode,
        relationshipState,
        "## Post-Reply Relationship Consideration",
        runtimeContextTemplate(
          "relationship-pass-decision",
          {},
          "Decide silently whether relationships should be updated. Use record_relationship only if an update is useful.",
        ),
        input.additionalDecisionInstruction ?? "",
      ].filter((part) => part !== "").join("\n\n"),
      modelProfile: config.modelProfile,
      maxToolCalls: config.maxToolCalls,
      terminateAfterSuccessfulToolRoundNames: ["record_relationship"],
      transcript: input.memoryRequest.maintenanceTranscript,
      promptContext: input.memoryRequest.promptContext,
      requestLog: relationshipsLog,
      log: log.child({ guildId, channelId, requestId: relationshipsLog.requestId, component: "relationships-pass" }),
    });
  } catch (err) {
    relationshipsLog.setError(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    if (input.requestLog === undefined) {
      relationshipsLog.emit(log);
      requestLogStore.decrementActive();
    }
  }
}

async function runInnerThreadPostReplyExtraction(input: {
  guildConfig: GuildConfig;
  memoryRequest: Parameters<NonNullable<HandlerDeps["afterReply"]>>[0];
  guild: Guild;
  channel: unknown;
  sourceRequestId: string;
  dryRun?: boolean;
  maintenanceTools?: AgentTool[];
}): Promise<void> {
  if (!innerThreadsEnabled(input.guildConfig) || !hasMaintenanceMaterial(input.memoryRequest)) return;
  const guildId = input.memoryRequest.incomingMessage.guildId ?? input.guild.id;
  const channelId = input.memoryRequest.incomingMessage.channelId ?? "";
  const sourceMessageId = input.memoryRequest.sourceMessageId ?? promptLabSyntheticId();
  const requestLog = new RequestLog(guildId, channelId, requestLogStore);
  requestLog.setAuthor(input.memoryRequest.incomingMessage.authorUsername);
  requestLog.setTrigger({
    type: "inner_thread_maintenance",
    sourceRequestId: input.sourceRequestId,
    ...(input.dryRun === true ? { dryRun: true } : {}),
  });
  requestLog.setTriggerContext({
    ...dashboardTriggerLocation(input.guild, input.channel),
    messageId: sourceMessageId,
    authorUsername: input.memoryRequest.incomingMessage.authorUsername,
    content: input.memoryRequest.userMessage,
    translatedContent: input.memoryRequest.userMessage,
  });
  requestLog.setAgentRan(true);
  requestLogStore.incrementActive();
  const maintenanceTools = input.maintenanceTools ?? createPostReplyMaintenanceTools({
    guild: input.guild,
    guildConfig: input.guildConfig,
    memoryRequest: input.memoryRequest,
    currentUserId: input.memoryRequest.incomingMessage.authorId,
    currentUsername: input.memoryRequest.incomingMessage.authorUsername,
    sourceMessageId,
    sourceRequestId: input.sourceRequestId,
    dryRun: input.dryRun,
  });
  const maintenanceContext = buildInnerThreadMaintenanceContext({
    db,
    guildId,
    visibleUserIds: [
      input.memoryRequest.incomingMessage.authorId,
      ...(input.memoryRequest.context.visibleUserIds ?? []),
    ],
    resolveUserId: (userId) => resolvePromptUsername(input.guild, userId),
    resolveGuildId: (otherGuildId) => client.guilds.cache.get(otherGuildId)?.name,
  });
  try {
    await runSilentToolAgentPass({
      globalConfig: getGlobalConfig(),
      guildConfig: input.guildConfig,
      context: input.memoryRequest.context,
      systemPrompt: getPromptBundle().systemPrompt,
      personaPrompt: getPromptBundle().corePrompt,
      runtimePrompts: getPromptBundle().runtime,
      incomingMessage: input.memoryRequest.incomingMessage,
      userContent: input.memoryRequest.userMessage,
      assistantReply: input.memoryRequest.assistantReply,
      visibleReplySent: input.memoryRequest.visibleReplySent,
      tools: toolsForMaintenancePass(
        input.memoryRequest.availableTools,
        maintenanceTools,
        "record_inner_threads",
        "silent inner-thread pass",
      ),
      runtimeInstruction: getPromptBundle().runtime.reply,
      controlMessage: [
        maintenanceContext,
        runtimeContextTemplate(
          "inner-thread-maintenance-execution-mode",
          {},
          "Private inner-thread maintenance is active. Read-only tools are available for material uncertainty; record_inner_threads is the only state-changing tool available.",
        ),
        runtimeContextTemplate(
          "inner-thread-pass-decision",
          {},
          "Decide silently whether durable inner threads should change.",
        ),
      ].filter((part) => part !== "").join("\n\n"),
      modelProfile: input.guildConfig.innerThreads?.modelProfile ?? input.guildConfig.modelProfile,
      maxToolCalls: 3,
      terminateAfterSuccessfulToolRoundNames: ["record_inner_threads"],
      transcript: input.memoryRequest.maintenanceTranscript,
      promptContext: input.memoryRequest.promptContext,
      requestLog,
      log: log.child({ guildId, channelId, requestId: requestLog.requestId, component: "inner-thread-pass" }),
    });
  } catch (error) {
    requestLog.setError(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    requestLog.emit(log);
    requestLogStore.decrementActive();
  }
}

async function runPrivateLifeMaintenance(input: {
  episodeId: string;
  guild: Guild;
  channel: SendableGuildChannel;
  guildConfig: GuildConfig;
  request: MemoryExtractionRequest;
  sourceRequestId: string;
  dryRun: boolean;
  dryRuns: Array<{ tool: string; args: unknown }>;
}): Promise<void> {
  const privateMaintenanceTools = (allowedToolName: MaintenanceWriteToolName): AgentTool[] =>
    promptLabMaintenanceDryRunTools(
      createPrivateLifeMaintenanceTools({
        episodeId: input.episodeId,
        guild: input.guild,
        guildConfig: input.guildConfig,
        memoryRequest: input.request,
        sourceRequestId: input.sourceRequestId,
        dryRun: input.dryRun,
      }),
      allowedToolName,
      input.dryRun ? input.dryRuns : undefined,
    );

  await runPrivateLifeEpisodeSummary({
    ...input,
    maintenanceTools: privateMaintenanceTools("record_private_life_episode"),
  });

  const latestHuman = latestHumanIdentity(input.guild.id, input.channel.id);
  await runMemoryPostReplyExtraction({
    guildConfig: input.guildConfig,
    memoryRequest: input.request,
    guild: input.guild,
    channel: input.channel,
    sourceRequestId: input.sourceRequestId,
    source: "private_life",
    currentUserId: latestHuman.userId,
    currentUsername: latestHuman.username,
    dryRun: input.dryRun,
    maintenanceTools: privateMaintenanceTools("record_memory"),
  });
  await runRelationshipPostReplyExtraction({
    guildConfig: input.guildConfig,
    memoryRequest: input.request,
    guild: input.guild,
    channel: input.channel,
    sourceRequestId: input.sourceRequestId,
    source: "private_life",
    currentUserId: latestHuman.userId,
    currentUsername: latestHuman.username,
    dryRun: input.dryRun,
    maintenanceTools: privateMaintenanceTools("record_relationship"),
    additionalDecisionInstruction: [
      "## Private-Life Relationship Scope",
      "No human speaker caused this private-life turn. Do not default to the synthetic author or latest active user. Every relationship signal must name a grounded known Discord user ID; otherwise do nothing.",
    ].join("\n"),
  });
  await runInnerThreadPostReplyExtraction({
    guildConfig: input.guildConfig,
    memoryRequest: input.request,
    guild: input.guild,
    channel: input.channel,
    sourceRequestId: input.sourceRequestId,
    dryRun: input.dryRun,
    maintenanceTools: privateMaintenanceTools("record_inner_threads"),
  });
}

async function runPrivateLifeEpisodeSummary(input: {
  episodeId: string;
  guild: Guild;
  channel: SendableGuildChannel;
  guildConfig: GuildConfig;
  request: MemoryExtractionRequest;
  sourceRequestId: string;
  dryRun: boolean;
  maintenanceTools: AgentTool[];
}): Promise<void> {
  const guildId = input.guild.id;
  const channelId = input.channel.id;
  const maintenanceLog = new RequestLog(guildId, channelId, requestLogStore);
  maintenanceLog.setAuthor("private-life-summary");
  maintenanceLog.setTrigger({
    type: "private_life_summary",
    sourceRequestId: input.sourceRequestId,
    episodeId: input.episodeId,
    ...(input.dryRun ? { dryRun: true } : {}),
  });
  maintenanceLog.setTriggerContext({
    ...dashboardTriggerLocation(input.guild, input.channel),
    messageId: input.episodeId,
    authorUsername: "private-life",
    content: input.request.userMessage,
    translatedContent: input.request.userMessage,
  });
  maintenanceLog.setAgentRan(true);
  requestLogStore.incrementActive();
  try {
    await runSilentToolAgentPass({
      globalConfig: getGlobalConfig(),
      guildConfig: input.guildConfig,
      context: input.request.context,
      systemPrompt: getPromptBundle().systemPrompt,
      personaPrompt: getPromptBundle().corePrompt,
      runtimePrompts: getPromptBundle().runtime,
      incomingMessage: input.request.incomingMessage,
      userContent: input.request.userMessage,
      assistantReply: input.request.assistantReply,
      visibleReplySent: input.request.visibleReplySent,
      tools: toolsForMaintenancePass(
        input.request.availableTools,
        input.maintenanceTools,
        "record_private_life_episode",
        "private-life episode summary pass",
      ),
      runtimeInstruction: [getPromptBundle().runtime.reply, getPromptBundle().runtime.privateLife ?? ""]
        .filter((part) => part.trim() !== "")
        .join("\n\n"),
      controlMessage: runtimeContextTemplate("private-life-maintenance"),
      modelProfile: getGlobalConfig().privateLife?.maintenance.modelProfile ?? input.guildConfig.modelProfile,
      maxToolCalls: 3,
      terminateAfterSuccessfulToolRoundNames: ["record_private_life_episode"],
      transcript: input.request.maintenanceTranscript,
      promptContext: input.request.promptContext,
      requestLog: maintenanceLog,
      log: log.child({ component: "private-life-summary", episodeId: input.episodeId }),
    });
  } catch (error) {
    maintenanceLog.setError(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    maintenanceLog.emit(log);
    requestLogStore.decrementActive();
  }
}

function createPrivateLifeMaintenanceTools(input: {
  episodeId: string;
  guild: Guild;
  guildConfig: GuildConfig;
  memoryRequest: MemoryExtractionRequest;
  sourceRequestId: string;
  dryRun: boolean;
}): AgentTool[] {
  const latestHuman = latestHumanIdentity(
    input.guild.id,
    input.memoryRequest.incomingMessage.channelId ?? "",
  );
  return applyRuntimeToolPrompts([
    ...createPostReplyMaintenanceTools({
      guild: input.guild,
      guildConfig: input.guildConfig,
      memoryRequest: input.memoryRequest,
      currentUserId: latestHuman.userId,
      currentUsername: latestHuman.username,
      sourceMessageId: input.episodeId,
      sourceRequestId: input.sourceRequestId,
      dryRun: input.dryRun,
      relationshipUserId: null,
    }),
    createPrivateLifeSummaryTool({
      db,
      episodeId: input.episodeId,
      description: runtimeToolDescription("record_private_life_episode"),
      dryRun: input.dryRun,
    }),
  ], getPromptBundle().runtime);
}

function startCleanup(): () => void {
  const timer = setInterval(() => {
    const deleted = deleteExpiredMemories(db);
    if (deleted > 0) log.info("expired memories cleaned", { deleted });
    const thoughtRetentionDays = getGlobalConfig().privateLife?.thoughtRetentionDays ?? 0;
    const clearedThoughts = clearExpiredPrivateLifeThoughts(db, Date.now() - thoughtRetentionDays * 86_400_000);
    if (clearedThoughts > 0) log.info("expired private-life thoughts cleared", { clearedThoughts, thoughtRetentionDays });
    void cleanStagedAssets().catch((error: unknown) => {
      log.warn("staged asset cleanup failed", { error: error instanceof Error ? error.message : String(error) });
    });
    const deletedAgentJobs = agentJobs.cleanup();
    if (deletedAgentJobs > 0) log.info("expired unlinked agent jobs cleaned", { deleted: deletedAgentJobs });
  }, 60 * 60 * 1000);
  return () => { clearInterval(timer); };
}

async function cleanStagedAssets(): Promise<void> {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const stagingRoot = process.env.WORKSPACE_STAGING_DIR ?? `${getGlobalConfig().dataDir}/staged-assets`;
  let deleted = 0;
  for (const staged of listStagedAssets(db, { unresolvedOnly: true, limit: 500, oldestFirst: true })) {
    const safePath = await resolveStagedPath(stagingRoot, staged.storagePath).catch(() => null);
    const modifiedAt = safePath === null ? 0 : await stat(safePath).then((value) => value.mtimeMs).catch(() => 0);
    if (modifiedAt > cutoff) continue;
    if (staged.jobId !== undefined) agentJobs.markExpired(staged.jobId);
    if (safePath !== null) await unlinkStagedPath(stagingRoot, staged.storagePath).catch(() => {});
    deleteStagedAsset(db, staged.ref);
    deleted++;
  }
  if (deleted > 0) log.info("expired staged assets cleaned", { deleted });
}


  return { blockToolsExcept, toolsForMaintenancePass, latestHumanIdentity, createPostReplyMaintenanceTools, runMemoryPostReplyExtraction, runRelationshipPostReplyExtraction, runInnerThreadPostReplyExtraction, runPrivateLifeMaintenance, createPrivateLifeMaintenanceTools, startCleanup };
}
