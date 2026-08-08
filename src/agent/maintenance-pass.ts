import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import type { AssembledContext } from "./context-assembly.ts";
import { currentLocalContext } from "../time/agent-time.ts";
import { buildModelProfileStreamOptions, resolveModelProfile, resolveModelProfileModel } from "../llm/client.ts";
import { completeLlmChat } from "../llm/chat.ts";
import type { OpenRouterMessage, OpenRouterToolCall } from "../llm/types.ts";
import { prependStableSectionsToCodexPayload, prependStableSectionsToPayload } from "./prompt-cache.ts";
import { wrapToolsWithTiming } from "./tool-timing.ts";
import { initialMaintenanceToolNames } from "./tool-catalog.ts";
import type { IncomingMessage, MaintenancePromptContext, SilentMemoryAgentInput, SilentToolAgentInput } from "./turn-types.ts";
import { AgentTimeBudgetExceededError } from "./model-retry.ts";
import { runNativeToolLoop, toolMessage } from "./model-loop.ts";
import { textFromMessageParts } from "./image-fallback.ts";
import { buildCodexPromptCacheKey, buildInitialMessages, buildProviderSessionId, buildRuntimeInstruction, buildVolatileTurnMessages, codexSystemPromptForStableSections, initialMessageRoles, maintenanceCacheSurface, promptTransportForProvider, runtimeContextTemplate, sectionsForStablePrompt, toolContractSignature } from "./turn-prompt.ts";

function portableActorTurnEvidence(
  transcript: readonly OpenRouterMessage[] | undefined,
  assistantReply: string,
): string {
  const evidence = (transcript ?? []).flatMap((message): string[] => {
    if (message.role !== "assistant" && message.role !== "tool") return [];
    const text = textFromMessageParts(message);
    const calls = (message.tool_calls ?? []).map((call) =>
      `${call.function.name}(${call.function.arguments})`
    );
    const parts = [
      ...(text !== "" ? [text] : []),
      ...(calls.length > 0 ? [`Tool calls:\n${calls.join("\n")}`] : []),
    ];
    if (parts.length === 0) return [];
    const source = message.role === "tool" ? `tool:${message.name ?? "unknown"}` : "assistant";
    return [`[${source}]\n${parts.join("\n")}`];
  });
  if (evidence.length > 0) return evidence.join("\n\n");
  return assistantReply.trim();
}

function appendDeferredMaintenanceTools(
  messages: OpenRouterMessage[],
  toolNames: readonly string[],
): void {
  if (toolNames.length === 0) return;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ messageCount: messages.length, toolNames }))
    .digest("hex")
    .slice(0, 16);
  const call: OpenRouterToolCall = {
    id: `maintenance-tool-load-${fingerprint}`,
    type: "function",
    function: {
      name: "search_tools",
      arguments: JSON.stringify({
        query: toolNames.join(" "),
        limit: toolNames.length,
      }),
    },
  };
  messages.push({
    role: "user",
    content: "Load the private maintenance capability required for the next pass.",
  });
  messages.push({
    role: "assistant",
    content: null,
    tool_calls: [call],
  });
  messages.push(toolMessage(
    call,
    `Enabled private maintenance tools: ${toolNames.join(", ")}`,
    toolNames,
  ));
}
export function memoryExtractionContext(context: AssembledContext): string {
  return context.sections
    .filter((section) => section.label === "Chat History — Newer")
    .map((section) => section.text)
    .join("\n\n");
}
function memoryPassControlMessage(input: SilentMemoryAgentInput): string {
  const now = Date.now();
  const passKind = input.passKind ?? "post_reply";
  const maxToolCalls = input.guildConfig.memoryExtraction.maxToolCalls;
  const executionMode = runtimeContextTemplate(
    input.runtimePrompts,
    "memory-maintenance-execution-mode",
    { maxToolCalls },
    [
      "## Execution Mode: Memory Maintenance",
      "Private memory maintenance is active. Read-only tools are optionally available when they would materially reduce uncertainty; record_memory is the only state-changing tool available.",
      "Submit every useful memory edit as one complete record_memory action list. Retry only if the tool reports an error, and retry only the failed work.",
      "If there are no memory changes, do not call record_memory; output nothing.",
    ].join("\n"),
  );
  const triggerContext = [
    passKind === "ambient"
      ? "## Memory Maintenance Review — Periodic Trigger"
      : "## Memory Maintenance Review — Post-Reply Trigger",
    "Current time for expiresIn and importantUntil decisions:",
    currentLocalContext(input.guildConfig.timezone, now),
  ].join("\n");
  return [
    input.visibleUserMemoryContext?.trim() ?? "",
    executionMode,
    triggerContext,
    passKind === "ambient"
      ? runtimeContextTemplate(
        input.runtimePrompts,
        "memory-pass-ambient-review",
        {},
        "Review ambient chat history for durable memory.",
      )
      : "",
    runtimeContextTemplate(
      input.runtimePrompts,
      "memory-pass-decision",
      {},
      "Decide silently whether durable memory should be updated.",
    ),
  ].filter((part) => part !== "").join("\n\n");
}

/** Run a private tool loop with no implicit Discord output. */
export async function runSilentToolAgentPass(input: SilentToolAgentInput): Promise<{
  text: string;
  transcript: OpenRouterMessage[];
  activeToolNames: string[];
  promptContext?: MaintenancePromptContext;
}> {
  if (input.tools.length === 0) {
    return { text: "", transcript: [...(input.transcript ?? [])], activeToolNames: [] };
  }

  const wallController = new AbortController();
  const parent = input.signal;
  let onParentAbort: (() => void) | undefined;
  if (parent !== undefined) {
    if (parent.aborted) {
      throw parent.reason instanceof Error ? parent.reason : new Error("Silent memory pass aborted");
    }
    onParentAbort = () => wallController.abort(parent.reason);
    parent.addEventListener("abort", onParentAbort, { once: true });
  }
  const wallClockTimeoutMs = input.wallClockTimeoutMs ?? input.guildConfig.replyLoop.wallClockTimeoutMs;
  const wallTimeout = setTimeout(() => {
    wallController.abort(new AgentTimeBudgetExceededError(wallClockTimeoutMs));
  }, wallClockTimeoutMs);

  const complete = input.completeChat ?? completeLlmChat;
  const inheritedPrompt = input.promptContext;
  const profileId = input.modelProfile ?? input.guildConfig.modelProfile;
  const profile = resolveModelProfile(input.globalConfig, profileId);
  const model = resolveModelProfileModel(input.globalConfig, profileId);
  const provider = profile.provider;
  const inheritedPromptCompatible = inheritedPrompt?.provider === provider
    && inheritedPrompt.model === model.id;
  const transport = inheritedPromptCompatible
    ? inheritedPrompt.transport
    : promptTransportForProvider(input.guildConfig.promptTransport, provider);
  const streamOptions = buildModelProfileStreamOptions(input.globalConfig, profileId);
  const providerParams: Record<string, unknown> = { ...streamOptions };
  delete providerParams.apiKey;
  delete providerParams.signal;
  delete providerParams.onPayload;
  const promptCaching = profile.promptCaching;
  const { tools: timedTools, state: timingState } = wrapToolsWithTiming(input.tools);
  const timedToolsByName = new Map(timedTools.map((tool) => [tool.name, tool]));
  const inheritedActiveToolNames = inheritedPrompt?.activeToolNames ?? [];
  const inheritedActiveTools = inheritedActiveToolNames
    .map((name) => timedToolsByName.get(name))
    .filter((tool): tool is AgentTool => tool !== undefined);
  const canContinueActorToolSurface = provider === "openai-codex"
    && inheritedPromptCompatible
    && input.transcript !== undefined
    && inheritedActiveToolNames.length > 0
    && inheritedActiveTools.length === inheritedActiveToolNames.length
    && inheritedPrompt.toolContractSignature !== undefined
    && toolContractSignature(inheritedActiveTools) === inheritedPrompt.toolContractSignature
    && inheritedActiveToolNames.includes("search_tools");
  const canReuseInheritedTranscript = inheritedPromptCompatible
    && (provider !== "openai-codex" || canContinueActorToolSurface);

  const stableSections = inheritedPromptCompatible ? inheritedPrompt.stableSections : sectionsForStablePrompt(
    input.systemPrompt ?? "",
    input.personaPrompt ?? "",
    "",
    input.context,
    "",
    input.runtimeInstruction,
    transport,
  );
  const sessionId = inheritedPromptCompatible
    ? inheritedPrompt.sessionId
    : buildProviderSessionId(input.requestLog, provider, model.id);
  const promptCacheKey = provider === "openai-codex"
    ? promptCaching.enabled
      ? canContinueActorToolSurface && inheritedPrompt.promptCacheKey !== undefined
        ? inheritedPrompt.promptCacheKey
        : buildCodexPromptCacheKey(
            input.globalConfig.runtimeProfileId ?? "default",
            profileId,
            model.id,
            maintenanceCacheSurface(input.tools),
          )
      : ""
    : undefined;
  const currentMessageWithoutImages: IncomingMessage = { ...input.incomingMessage, imageInputs: undefined };
  const volatileMessages = buildVolatileTurnMessages(input.context);
  const initialRoles = inheritedPromptCompatible
    ? inheritedPrompt.initialRoles
    : initialMessageRoles(transport, volatileMessages);
  const messages = (canReuseInheritedTranscript ? input.transcript : undefined) ?? buildInitialMessages(
    input.userContent,
    volatileMessages,
    currentMessageWithoutImages,
    input.runtimePrompts,
    provider === "openai-codex" ? [] : initialRoles,
  );
  if (!canReuseInheritedTranscript) {
    const actorEvidence = portableActorTurnEvidence(input.transcript, input.assistantReply);
    if (actorEvidence !== "") {
      messages.push({
        role: "user",
        content: `## Completed Actor Turn Evidence\n${actorEvidence}`,
      });
    }
  }
  const maintenanceToolNames = (input.terminateAfterSuccessfulToolRoundNames ?? [])
    .filter((name) => name.startsWith("record_") && timedToolsByName.has(name));
  const hasMaintenanceSearchTool = timedTools.some((tool) => tool.name === "search_tools");
  const fallbackMaintenanceInitialToolNames = maintenanceToolNames.length > 0 && hasMaintenanceSearchTool
    ? new Set(timedTools
        .map((tool) => tool.name)
        .filter((name) => name === "search_tools" || maintenanceToolNames.includes(name)))
    : hasMaintenanceSearchTool
      ? initialMaintenanceToolNames(timedTools)
      : new Set(timedTools.map((tool) => tool.name));
  const maintenanceInitialToolNames = canContinueActorToolSurface
      ? new Set([...inheritedActiveToolNames, ...maintenanceToolNames])
      : fallbackMaintenanceInitialToolNames;
  const newlyActiveMaintenanceTools = maintenanceToolNames
    .filter((name) => !inheritedActiveToolNames.includes(name));
  if (provider === "openai-codex" && hasMaintenanceSearchTool) {
    appendDeferredMaintenanceTools(messages, newlyActiveMaintenanceTools);
  }
  if (input.controlMessage !== "") messages.push({ role: "user", content: input.controlMessage });

  const maxToolCalls = input.maxToolCalls === null
    ? undefined
    : Math.max(1, input.maxToolCalls ?? input.tools.length);
  let activeToolNames = [...maintenanceInitialToolNames];
  timingState.resetAgentLoopStart();
  try {
    const requestBase = {
      provider,
      apiKey: streamOptions.apiKey,
      model: model.id,
      systemPrompt: provider === "openai-codex" ? codexSystemPromptForStableSections(stableSections, transport) : "",
      providerParams,
      sessionId,
      promptCacheKey,
      onPayload: (payload: unknown) => {
        if (provider === "openrouter") {
          prependStableSectionsToPayload(
            payload,
            stableSections,
            promptCaching,
            model.id,
          );
        } else if (transport.mode === "split-input") {
          prependStableSectionsToCodexPayload(payload, stableSections, initialRoles, {
            enabled: promptCaching.enabled,
            promptCacheKey,
          });
        }
        input.requestLog?.recordLLMRequest(payload);
        input.log?.debug("memory_llm_request_payload", { payload });
      },
    };
    const result = await runNativeToolLoop({
      complete,
      requestBase,
      messages,
      tools: timedTools,
      initialToolNames: maintenanceInitialToolNames,
      maxToolCalls,
      maxToolRounds: input.maxToolCalls === null
        ? undefined
        : input.maxToolCalls !== undefined
          ? maxToolCalls
        : Math.min(input.guildConfig.replyLoop.maxToolCalls, 3),
      agentTimeBudgetMs: wallClockTimeoutMs,
      llmOutputTimeoutMs: input.guildConfig.replyLoop.llmOutputTimeoutMs,
      requestLog: input.requestLog,
      imageInputSupported: false,
      pendingAttachments: [],
      toolTiming: timingState,
      runtimePrompts: input.runtimePrompts,
      log: input.log,
      signal: wallController.signal,
      allowEmptyFinalResponse: true,
      stopOnAgentTimeBudget: true,
      terminateAfterSuccessfulToolRoundNames: input.terminateAfterSuccessfulToolRoundNames,
      onActiveToolsChanged: canContinueActorToolSurface
        ? (activeTools) => {
            activeToolNames = activeTools.map((tool) => tool.name);
            inheritedPrompt.activeToolNames = activeTools.map((tool) => tool.name);
            inheritedPrompt.toolContractSignature = toolContractSignature(activeTools);
          }
        : (activeTools) => {
            activeToolNames = activeTools.map((tool) => tool.name);
          },
    });
    const activeTools = activeToolNames
      .map((name) => timedToolsByName.get(name))
      .filter((tool): tool is AgentTool => tool !== undefined);
    return {
      text: result.text,
      transcript: messages,
      activeToolNames,
      promptContext: {
        provider,
        model: model.id,
        transport,
        stableSections,
        initialRoles,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
        promptCaching,
        toolContractSignature: toolContractSignature(activeTools),
        activeToolNames,
        ...(canReuseInheritedTranscript && inheritedPrompt.loadedSkillIds !== undefined
          ? { loadedSkillIds: [...inheritedPrompt.loadedSkillIds] }
          : {}),
      },
    };
  } finally {
    clearTimeout(wallTimeout);
    if (parent !== undefined && onParentAbort !== undefined) {
      parent.removeEventListener("abort", onParentAbort);
    }
  }
}

/** Run the post-reply memory maintenance loop with only memory tools and no Discord output hooks. */
export async function runSilentMemoryAgentPass(
  input: SilentMemoryAgentInput,
): ReturnType<typeof runSilentToolAgentPass> {
  return await runSilentToolAgentPass({
    ...input,
    runtimeInstruction: buildRuntimeInstruction(input.runtimePrompts),
    controlMessage: memoryPassControlMessage(input),
    modelProfile: input.guildConfig.memoryExtraction.modelProfile,
    maxToolCalls: input.guildConfig.memoryExtraction.maxToolCalls,
    terminateAfterSuccessfulToolRoundNames: ["record_memory"],
  });
}
