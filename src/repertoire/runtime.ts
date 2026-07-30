import type { Database } from "../db/database.ts";
import {
  getRepertoireRefreshState,
  loadRepertoireAnchors,
  markRepertoireRefreshAttempt,
  replaceRepertoireSnapshot,
  type RepertoireAnchorSelection,
} from "../db/repertoire-repository.ts";
import type { GlobalConfig, RepertoireConfig } from "../config/types.ts";
import type { Logger, RequestLog } from "../logger.ts";
import { RequestLog as RuntimeRequestLog } from "../logger.ts";
import type { RequestLogStore } from "../dashboard/store.ts";
import { completeLlmChat } from "../llm/chat.ts";
import {
  buildModelProfileStreamOptions,
  resolveModelProfile,
  resolveModelProfileModel,
} from "../llm/client.ts";
import type { OpenRouterChatRequest, OpenRouterChatResult } from "../llm/types.ts";
import {
  countEligibleBotMessagesAfter,
  getLatestEligibleBotCursor,
  listRepertoireExchanges,
  renderRepertoireCandidates,
  type RepertoireCursor,
  type RepertoireExchange,
} from "./exchanges.ts";

export interface RepertoireRefreshResult {
  recentIds: string[];
  anchors: Array<{
    candidateId: string;
    scope: "profile" | "guild";
    condition: string;
  }>;
}

export type RepertoireCompleteChat = (
  request: OpenRouterChatRequest,
) => Promise<OpenRouterChatResult>;

const MAX_ANCHOR_CONDITION_CHARS = 200;
let refreshActive = false;

function responseFormat(config: RepertoireConfig): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "repertoire_refresh",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["recentIds", "anchors"],
        properties: {
          recentIds: {
            type: "array",
            maxItems: config.maxRecentEntries,
            items: { type: "string" },
          },
          anchors: {
            type: "array",
            maxItems: config.maxAnchorEntries,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["candidateId", "scope", "condition"],
              properties: {
                candidateId: { type: "string" },
                scope: { type: "string", enum: ["profile", "guild"] },
                condition: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_ANCHOR_CONDITION_CHARS,
                },
              },
            },
          },
        },
      },
    },
  };
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length
    && actual.every((key, index) => key === [...keys].sort()[index]);
}

/** Strictly validate model selection before any durable replacement. */
export function validateRepertoireRefreshResult(
  value: unknown,
  input: {
    recentCandidateIds: ReadonlySet<string>;
    anchorCandidateIds: ReadonlySet<string>;
    maxRecentEntries: number;
    maxAnchorEntries: number;
  },
): RepertoireRefreshResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (!exactKeys(result, ["anchors", "recentIds"])) return null;
  if (!Array.isArray(result.recentIds) || !Array.isArray(result.anchors)) return null;
  if (
    result.recentIds.length > input.maxRecentEntries
    || result.anchors.length > input.maxAnchorEntries
    || result.recentIds.length + result.anchors.length === 0
  ) {
    return null;
  }

  const recentIds: string[] = [];
  const anchors: RepertoireRefreshResult["anchors"] = [];
  const selectedIds = new Set<string>();
  for (const id of result.recentIds) {
    if (
      typeof id !== "string"
      || !input.recentCandidateIds.has(id)
      || selectedIds.has(id)
    ) {
      return null;
    }
    selectedIds.add(id);
    recentIds.push(id);
  }
  for (const raw of result.anchors) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const anchor = raw as Record<string, unknown>;
    if (!exactKeys(anchor, ["candidateId", "condition", "scope"])) return null;
    if (
      typeof anchor.candidateId !== "string"
      || !input.anchorCandidateIds.has(anchor.candidateId)
      || selectedIds.has(anchor.candidateId)
      || (anchor.scope !== "profile" && anchor.scope !== "guild")
      || typeof anchor.condition !== "string"
    ) {
      return null;
    }
    const condition = anchor.condition.trim();
    if (condition === "" || condition.length > MAX_ANCHOR_CONDITION_CHARS) return null;
    selectedIds.add(anchor.candidateId);
    anchors.push({
      candidateId: anchor.candidateId,
      scope: anchor.scope,
      condition,
    });
  }
  return { recentIds, anchors };
}

function isAfter(exchange: RepertoireExchange, cursor: RepertoireCursor | null): boolean {
  return cursor === null
    || exchange.respondedAt > cursor.createdAt
    || (exchange.respondedAt === cursor.createdAt && exchange.id > cursor.messageId);
}

function currentAnchorsText(anchors: readonly RepertoireAnchorSelection[]): string {
  if (anchors.length === 0) return "None.";
  return anchors.map((anchor) => [
    `Candidate ${anchor.exchange.id}: current ${anchor.scope} anchor`,
    `Current condition: ${anchor.condition}`,
    `Source guild ID: ${anchor.exchange.guildId}`,
    `Source channel ID: ${anchor.exchange.channelId}`,
    `Participant: ${anchor.exchange.cue.text}`,
    ...anchor.exchange.responses.map((response) => `2B: ${response.text}`),
  ].join("\n")).join("\n\n");
}

export interface MaybeRefreshRepertoireInput {
  db: Database;
  globalConfig: GlobalConfig;
  botUserId: string;
  guildId: string;
  channelId: string;
  mergeMessageGapSeconds: number;
  llmOutputTimeoutMs: number;
  systemPrompt: string;
  personaPrompt: string;
  runtimePrompt: string;
  decisionInstruction: string;
  requestLogStore: RequestLogStore;
  log: Logger;
  now?: number;
  completeChat?: RepertoireCompleteChat;
}

export interface MaybeRefreshRepertoireOutcome {
  ran: boolean;
  succeeded: boolean;
  error?: string;
}

function failed(error: unknown): MaybeRefreshRepertoireOutcome {
  return {
    ran: true,
    succeeded: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

/** Opportunistically refresh the one profile-wide stable snapshot. */
export async function maybeRefreshRepertoire(
  input: MaybeRefreshRepertoireInput,
): Promise<MaybeRefreshRepertoireOutcome> {
  const config = input.globalConfig.repertoire;
  if (!config.enabled || input.botUserId === "" || refreshActive) {
    return { ran: false, succeeded: false };
  }
  const now = input.now ?? Date.now();
  const state = getRepertoireRefreshState(input.db);
  if (
    state.lastAttemptAt !== 0
    && now - state.lastAttemptAt < config.retryCooldownMinutes * 60_000
  ) {
    return { ran: false, succeeded: false };
  }
  const through = getLatestEligibleBotCursor(input.db, input.botUserId);
  if (through === null || countEligibleBotMessagesAfter(input.db, input.botUserId, state.through) === 0) {
    return { ran: false, succeeded: false };
  }
  const newExchanges = listRepertoireExchanges(input.db, {
    botUserId: input.botUserId,
    since: state.through?.createdAt ?? now - config.candidateLookbackHours * 60 * 60_000,
    through,
    mergeMessageGapSeconds: input.mergeMessageGapSeconds,
    maxCandidates: config.maxCandidates,
    maxSourceChannels: 10_000,
    maxEntriesPerChannel: config.maxEntriesPerChannel,
    maxEntriesPerGuild: config.maxEntriesPerGuild,
  }).filter((exchange) => isAfter(exchange, state.through));
  if (newExchanges.length === 0) return { ran: false, succeeded: false };

  const pendingCount = countEligibleBotMessagesAfter(input.db, input.botUserId, state.through);
  const ageDue = state.lastSuccessAt === 0
    || now - state.lastSuccessAt >= config.refreshAfterMinutes * 60_000;
  if (pendingCount < config.refreshAfterBotMessages && !ageDue) {
    return { ran: false, succeeded: false };
  }

  const recentCandidates = listRepertoireExchanges(input.db, {
    botUserId: input.botUserId,
    since: now - config.candidateLookbackHours * 60 * 60_000,
    through,
    mergeMessageGapSeconds: input.mergeMessageGapSeconds,
    maxCandidates: config.maxCandidates,
    maxSourceChannels: config.maxSourceChannels,
    maxEntriesPerChannel: config.maxEntriesPerChannel,
    maxEntriesPerGuild: config.maxEntriesPerGuild,
  });
  if (recentCandidates.length === 0) return { ran: false, succeeded: false };
  const currentAnchors = loadRepertoireAnchors(
    input.db,
    input.botUserId,
    input.mergeMessageGapSeconds,
  );
  const recentById = new Map(recentCandidates.map((candidate) => [candidate.id, candidate]));
  const anchorById = new Map(currentAnchors.map((anchor) => [anchor.exchange.id, anchor.exchange]));
  for (const candidate of recentCandidates) anchorById.set(candidate.id, candidate);

  refreshActive = true;
  markRepertoireRefreshAttempt(input.db, now);
  const requestLog: RequestLog = new RuntimeRequestLog(
    input.guildId,
    input.channelId,
    input.requestLogStore,
  );
  requestLog.setAuthor("repertoire");
  requestLog.setTrigger({ type: "repertoire_refresh" });
  requestLog.setTriggerContext({
    messageId: through.messageId,
    content: `${recentCandidates.length} recent candidates; ${currentAnchors.length} retained anchors`,
  });
  requestLog.setAgentRan(true);
  input.requestLogStore.incrementActive();

  try {
    const profile = resolveModelProfile(input.globalConfig, config.modelProfile);
    const model = resolveModelProfileModel(input.globalConfig, config.modelProfile);
    const streamOptions = buildModelProfileStreamOptions(input.globalConfig, config.modelProfile);
    const providerParams: Record<string, unknown> = { ...streamOptions };
    delete providerParams.apiKey;
    const complete = input.completeChat ?? completeLlmChat;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error("Repertoire refresh model call timed out."));
    }, input.llmOutputTimeoutMs);
    let completion: OpenRouterChatResult;
    try {
      try {
        completion = await complete({
          provider: profile.provider,
          apiKey: streamOptions.apiKey,
          model: model.id,
          systemPrompt: [
            input.systemPrompt,
            input.personaPrompt,
            input.runtimePrompt,
            input.decisionInstruction,
          ].filter((part) => part.trim() !== "").join("\n\n"),
          messages: [{
            role: "user",
            content: [
              "## Current retained anchors",
              currentAnchorsText(currentAnchors),
              "## Recent exchange candidates",
              renderRepertoireCandidates(recentCandidates),
            ].join("\n\n"),
          }],
          providerParams,
          responseFormat: responseFormat(config),
          toolChoice: "none",
          signal: controller.signal,
          onPayload: (payload) => requestLog.recordLLMRequest(payload),
        });
      } catch (error) {
        requestLog.recordLLMError(error);
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
    requestLog.recordLLMCompletion(completion.messageForLogs);

    let parsed: unknown;
    try {
      parsed = JSON.parse(completion.text);
    } catch {
      throw new Error("Repertoire refresh returned malformed JSON.");
    }
    const selection = validateRepertoireRefreshResult(parsed, {
      recentCandidateIds: new Set(recentById.keys()),
      anchorCandidateIds: new Set(anchorById.keys()),
      maxRecentEntries: config.maxRecentEntries,
      maxAnchorEntries: config.maxAnchorEntries,
    });
    if (selection === null) {
      throw new Error("Repertoire refresh returned an invalid selection.");
    }
    replaceRepertoireSnapshot(input.db, {
      recent: selection.recentIds.map((id) => recentById.get(id) as RepertoireExchange),
      anchors: selection.anchors.map((anchor) => ({
        exchange: anchorById.get(anchor.candidateId) as RepertoireExchange,
        scope: anchor.scope,
        condition: anchor.condition,
      })),
      through,
      now,
    });
    return { ran: true, succeeded: true };
  } catch (error) {
    requestLog.setError(error instanceof Error ? error.message : String(error));
    input.log.warn("repertoire refresh failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return failed(error);
  } finally {
    requestLog.emit(input.log);
    input.requestLogStore.decrementActive();
    refreshActive = false;
  }
}
