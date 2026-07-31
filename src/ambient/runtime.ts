import type { PromptLabRunResult } from "../dashboard/prompt-lab-types";
import {
  createAmbientAttentionRuntime,
  type AmbientAttentionRuntime,
  type AmbientRuntimeDeps,
} from "./attention-runtime";
import { createGenericAmbientInitiativeRuntime } from "./initiative-runtime";

export type { AmbientRuntimeDeps } from "./attention-runtime";

export type AmbientRuntime = Omit<AmbientAttentionRuntime, "pendingAmbientCandidatesInChannel"> & {
  runAmbientInitiativeOpportunity: (
    guildId: string,
    mode?: "automatic" | "draft" | "shadow",
    runToken?: string,
  ) => Promise<{ requestId?: string; error?: string }>;
  scheduleAmbientInitiativeGuild: (guildId: string) => void;
  startAmbientInitiativeLoops: () => void;
  runPromptLabAmbientInitiative: (input: {
    guildId: string;
    channelId: string;
    force?: boolean;
    runToken?: string;
  }) => Promise<PromptLabRunResult>;
  clearAmbientInitiativeState: () => void;
};

/** Coordinate ambient attention and generic initiative without sharing runtime internals. */
export function createAmbientRuntime(input: AmbientRuntimeDeps): AmbientRuntime {
  const attention = createAmbientAttentionRuntime(input);
  const initiative = createGenericAmbientInitiativeRuntime({
    db: input.db,
    client: input.client,
    log: input.log,
    requestLogStore: input.requestLogStore,
    agentJobs: input.agentJobs,
    getPromptBundle: input.getPromptBundle,
    getGlobalConfig: input.getGlobalConfig,
    getGuildConfig: input.getGuildConfig,
    dashboardTriggerLocation: input.dashboardTriggerLocation,
    buildContext: input.buildContext,
    buildAgentTools: input.buildAgentTools,
    promptLabDryRunTools: input.promptLabDryRunTools,
    promptLabSyntheticId: input.promptLabSyntheticId,
    promptLabSummary: input.promptLabSummary,
    resolveClientGuild: input.resolveClientGuild,
    fetchAccessibleGuildChannel: input.fetchAccessibleGuildChannel,
    createSyntheticReplyFallbackDeps: input.createSyntheticReplyFallbackDeps,
    createBotDiscordMessageSender: input.createBotDiscordMessageSender,
    createVisibleMaintenanceTools: input.createVisibleMaintenanceTools,
    createHandlerDeps: input.createHandlerDeps,
    pendingAmbientCandidatesInChannel: attention.pendingAmbientCandidatesInChannel,
    isAutonomousAttentionBusy: input.isAutonomousAttentionBusy ?? (() => false),
    ...(input.waitForSemanticMaintenance !== undefined
      ? { waitForSemanticMaintenance: input.waitForSemanticMaintenance }
      : {}),
    ...(input.preparePersonaModeTurn !== undefined
      ? { preparePersonaModeTurn: input.preparePersonaModeTurn }
      : {}),
    ...(input.runMaintenance !== undefined ? { runMaintenance: input.runMaintenance } : {}),
  });
  const { pendingAmbientCandidatesInChannel: _, ...ambientAttention } = attention;
  return {
    ...ambientAttention,
    runAmbientInitiativeOpportunity: initiative.runOpportunity,
    scheduleAmbientInitiativeGuild: initiative.scheduleGuild,
    startAmbientInitiativeLoops: initiative.startLoops,
    runPromptLabAmbientInitiative: initiative.runPromptLab,
    clearAmbientInitiativeState: initiative.clear,
  };
}
