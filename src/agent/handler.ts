import { shouldRespond, type TriggerInput, type TriggerResult } from "./triggers.ts";
import { buildModelProfileStreamOptions, resolveModelProfile, resolveModelProfileModel } from "../llm/client.ts";
import { completeLlmChat } from "../llm/chat.ts";
import type { OpenRouterMessage } from "../llm/types.ts";
import { prependStableSectionsToCodexPayload, prependStableSectionsToPayload } from "./prompt-cache.ts";
import { parseResponseDirectives, renderSegmentsForMemory } from "./response-directives.ts";
import { createLoadSkillTool } from "./load-skill-tool.ts";
import { applyRuntimeToolPrompts } from "./runtime-tool-prompts.ts";
import { createSearchToolsTool, initialActorToolNames } from "./tool-catalog.ts";
import { wrapToolsWithTiming } from "./tool-timing.ts";
import { typingSimulationDelayMs } from "./typing-simulation.ts";
import type { HandlerDeps, HandleResult, IncomingMessage, MaintenancePromptContext, OutboundAttachment } from "./turn-types.ts";
import { supportsNativeImageInput, textFromMessageParts } from "./image-fallback.ts";
import { AgentTimeBudgetExceededError, assertActionCanCommit, makeToolErrorText } from "./model-retry.ts";
import { runNativeToolLoop } from "./model-loop.ts";
import { DEFAULT_LIVE_MESSAGE_TYPING_HOLD_MS, LiveMessageDispatcher, sendResponseSegments, type DispatchSegment } from "./response-delivery.ts";
import { memoryExtractionContext } from "./maintenance-pass.ts";
import { compactBackgroundTranscript } from "./background-compaction.ts";
import { buildCodexPromptCacheKey, buildFinalActionInstruction, buildInitialMessages, buildProviderSessionId, buildRuntimeInstruction, buildSkillsInstruction, buildVolatileTurnMessages, codexSystemPromptForStableSections, initialMessageRoles, promptTransportForProvider, sectionsForStablePrompt, toolContractSignature } from "./turn-prompt.ts";

function privateThoughtsFromTranscript(
  transcript: readonly OpenRouterMessage[] | undefined,
): string[] {
  return (transcript ?? []).flatMap((message): string[] => {
    if (message.role !== "assistant") return [];
    const parsed = parseResponseDirectives(textFromMessageParts(message));
    if (parsed.malformedPrivateOutput === true || parsed.directiveErrors !== undefined) return [];
    return parsed.privateThoughts ?? [];
  });
}

/**
 * Core message handler. Evaluates triggers, runs a native tool-calling persona reply,
 * sends the final Discord text, then optionally schedules background memory extraction.
 */
export async function handleMessage(
  msg: IncomingMessage,
  deps: HandlerDeps
): Promise<HandleResult> {
  let triggerResult: TriggerResult;

  if (deps.triggerOverride !== undefined) {
    triggerResult = deps.triggerOverride;
  } else if (deps.forceTrigger === true) {
    triggerResult = { reason: "scheduled" };
  } else {
    const triggerInput: TriggerInput = {
      content: msg.content,
      authorId: msg.authorId,
      authorIsBot: msg.authorIsBot,
      botUserId: msg.botUserId,
      mentionedUserIds: msg.mentionedUserIds,
      mentionedRoleIds: msg.mentionedRoleIds,
      botRoleIds: msg.botRoleIds,
      mentionedEveryone: msg.mentionedEveryone,
      repliedToBot: msg.repliedToBot,
    };

    triggerResult = shouldRespond(triggerInput, deps.guildConfig.triggers);
    if (triggerResult === null) {
      return { triggered: false, triggerResult: null, agentRan: false };
    }
  }

  deps.onTriggered?.(triggerResult);

  const context = deps.context;

  const profileId = deps.modelProfile ?? deps.guildConfig.modelProfile;
  const profile = resolveModelProfile(deps.globalConfig, profileId);
  const model = resolveModelProfileModel(deps.globalConfig, profileId);
  const baseStreamOptions = buildModelProfileStreamOptions(deps.globalConfig, profileId);
  const providerParams: Record<string, unknown> = { ...baseStreamOptions };
  delete providerParams.apiKey;
  delete providerParams.signal;
  delete providerParams.onPayload;
  const imageProfile = resolveModelProfile(
    deps.globalConfig,
    deps.guildConfig.imageReading.fallbackModelProfile,
  );
  const imageStreamOptions = deps.guildConfig.imageReading.fallbackEnabled
    ? buildModelProfileStreamOptions(
      deps.globalConfig,
      deps.guildConfig.imageReading.fallbackModelProfile,
    )
    : { apiKey: "" };
  const imageProviderParams: Record<string, unknown> = { ...imageStreamOptions };
  delete imageProviderParams.apiKey;
  delete imageProviderParams.signal;
  delete imageProviderParams.onPayload;

  const skillTool = deps.runtimePrompts !== undefined && Object.keys(deps.runtimePrompts.skills.byId).length > 0
    ? [createLoadSkillTool({ skills: deps.runtimePrompts.skills })]
    : [];
  const operationalTools = (deps.extraTools ?? []).filter((tool) => !tool.name.startsWith("record_"));
  const searchTool = deps.runtimePrompts === undefined
    ? []
    : [createSearchToolsTool({
        tools: operationalTools,
        skills: deps.runtimePrompts.skills,
      })];
  const loaderTools = deps.runtimePrompts === undefined
    ? [...searchTool, ...skillTool]
    : applyRuntimeToolPrompts([...searchTool, ...skillTool], deps.runtimePrompts);
  const tools = [...loaderTools, ...operationalTools];
  const { tools: timedTools, state: timingState } = wrapToolsWithTiming(tools);
  const actorInitialToolNames = deps.runtimePrompts === undefined
    ? new Set(timedTools.map((tool) => tool.name))
    : initialActorToolNames(timedTools, new Set(deps.initialToolNames ?? []));
  const actorInitialTools = timedTools.filter((tool) => actorInitialToolNames.has(tool.name));
  const complete = deps.completeChat ?? completeLlmChat;
  const runtimeInstruction = buildRuntimeInstruction(deps.runtimePrompts);
  const transport = promptTransportForProvider(deps.guildConfig.promptTransport, model.llmProvider);
  const stableSections = sectionsForStablePrompt(
    deps.systemPrompt ?? "",
    deps.personaPrompt ?? "",
    "",
    context,
    buildSkillsInstruction(deps.runtimePrompts),
    runtimeInstruction,
    transport,
  );
  const userContent = context.userMessage !== "" ? context.userMessage : msg.translatedContent;
  const volatileMessages = buildVolatileTurnMessages(context);
  const finalActionInstruction = deps.actorContinuation === undefined
    ? buildFinalActionInstruction(deps.runtimePrompts, deps.scheduledTaskRun === true)
    : "";
  const initialRoles = initialMessageRoles(transport, volatileMessages, finalActionInstruction !== "");
  const reqLog = deps.requestLog;
  const visibleToolSignature = toolContractSignature(actorInitialTools);
  const sessionId = buildProviderSessionId(reqLog, model.llmProvider, model.id);
  const promptCacheKey = model.llmProvider === "openai-codex"
    ? profile.promptCaching.enabled
      ? buildCodexPromptCacheKey(
          deps.globalConfig.runtimeProfileId ?? "default",
          profileId,
          model.id,
          "discord-actor",
        )
      : ""
    : undefined;
  const maintenancePromptContext: MaintenancePromptContext = {
    provider: model.llmProvider,
    model: model.id,
    transport,
    stableSections,
    initialRoles,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
    promptCaching: profile.promptCaching,
    toolContractSignature: visibleToolSignature,
    activeToolNames: actorInitialTools.map((tool) => tool.name),
    loadedSkillIds: [...(deps.actorContinuation?.loadedSkillIds ?? deps.loadedSkillIds ?? [])],
  };
  const startedAt = Date.now();
  const wallClockTimeoutMs = deps.actorContinuation?.wallClockTimeoutMs
    ?? deps.guildConfig.replyLoop.wallClockTimeoutMs;
  let modelActionCommitted = false;
  const commitModelAction = (): void => {
    if (modelActionCommitted) return;
    modelActionCommitted = true;
    deps.onActionCommitted?.();
  };
  let maintenanceTranscript: OpenRouterMessage[] | undefined;
  let finalText = "";
  let finalStopReason: string | undefined;
  const scheduleMemoryPass = (assistantReply: string, visibleReplySent: boolean): void => {
    const task = deps.afterReply?.({
      sourceMessageId: msg.messageId,
      userMessage: userContent,
      assistantReply,
      recentContext: memoryExtractionContext(context),
      context,
      incomingMessage: msg,
      visibleReplySent,
      maintenanceTranscript,
      availableTools: tools,
      promptContext: maintenancePromptContext,
    }).catch((error: unknown) => {
      deps.log?.warn("memory extraction failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    if (task === undefined) return;
    deps.trackBackgroundTask?.(task);
    void task;
  };

  try {
    deps.log?.debug("native_reply_loop_start", {
      model: model.id,
      modelImageInputSupport: deps.modelImageInputSupport ?? "registry",
      toolNames: actorInitialTools.map((tool) => tool.name),
      registeredToolCount: timedTools.length,
      maxToolCalls: deps.guildConfig.replyLoop.maxToolCalls,
      wallClockTimeoutMs,
      llmOutputTimeoutMs: deps.guildConfig.replyLoop.llmOutputTimeoutMs,
    });

    const wallController = new AbortController();
    const onCallerAbort = (): void => wallController.abort(deps.abortSignal?.reason);
    if (deps.abortSignal?.aborted === true) {
      wallController.abort(deps.abortSignal.reason);
    } else {
      deps.abortSignal?.addEventListener("abort", onCallerAbort, { once: true });
    }
    const wallTimeout = setTimeout(() => {
      wallController.abort(new AgentTimeBudgetExceededError(wallClockTimeoutMs));
    }, wallClockTimeoutMs);

    const pendingAttachments: OutboundAttachment[] = [];
    const intermediateStatus = { sent: false, sendCount: 0 };
    let visibleOutputDelivered = false;
    const noteVisibleOutput = (): void => {
      visibleOutputDelivered = true;
      deps.onVisibleOutput?.();
    };
    const hasVisibleOutput = (): boolean => visibleOutputDelivered || deps.hasExternalVisibleOutput?.() === true;
    const replyFirst = false;
    const liveMessageTypingHoldMs = deps.liveMessageTypingHoldMs ?? DEFAULT_LIVE_MESSAGE_TYPING_HOLD_MS;
    const typingHoldMsForSegment = deps.guildConfig.typingSimulation.enabled
      ? (segment: DispatchSegment): number => typingSimulationDelayMs(
        deps.guildConfig.typingSimulation,
        "output",
        segment.kind === "voice" ? segment.historyText : segment.text,
      )
      : undefined;
    const liveDispatchers = new Map<string, LiveMessageDispatcher>();
    const liveDispatcherFor = (destinationChannelId: string | undefined): LiveMessageDispatcher => {
      const key = destinationChannelId ?? "";
      const existing = liveDispatchers.get(key);
      if (existing !== undefined) return existing;
      const dispatcher = new LiveMessageDispatcher({
        sender: deps.sender,
        generateSpeech: deps.generateSpeech,
        ttsEnabled: deps.ttsEnabled ?? false,
        replyFirst: !hasVisibleOutput() && replyFirst,
        destinationChannelId,
        currentChannelId: deps.currentChannelId,
        requestLog: reqLog,
        log: deps.log,
        onStillWorking: deps.onStillWorking,
        getTypingStartedAt: deps.getTypingStartedAt,
        onVisibleOutput: noteVisibleOutput,
        onActionCommitted: commitModelAction,
        typingHoldMs: liveMessageTypingHoldMs,
        typingHoldMsForSegment,
        signal: wallController.signal,
        pendingAttachments,
        resolveAssetAttachments: deps.resolveAssetAttachments,
        onHandoffDelivered: deps.onHandoffDelivered,
      });
      liveDispatchers.set(key, dispatcher);
      return dispatcher;
    };
    const sendIntermediateStatus = async (text: string, destinationChannelId: string | undefined): Promise<boolean> => {
      const parsed = parseResponseDirectives(text);
      if (parsed.ignored || parsed.segments.length === 0) return false;
      intermediateStatus.sendCount += 1;
      try {
        intermediateStatus.sendCount = await sendResponseSegments({
          sender: deps.sender,
          generateSpeech: deps.generateSpeech,
          ttsEnabled: deps.ttsEnabled ?? false,
          segments: parsed.segments,
          replyFirst: !hasVisibleOutput() && replyFirst,
          sentOffset: intermediateStatus.sendCount - 1,
          destinationChannelId,
          currentChannelId: deps.currentChannelId,
          requestLog: reqLog,
          log: deps.log,
          onStillWorking: deps.onStillWorking,
          getTypingStartedAt: deps.getTypingStartedAt,
          onVisibleOutput: noteVisibleOutput,
          sendIdPrefix: "tool-status",
          typingHoldMs: liveMessageTypingHoldMs,
          typingHoldMsForSegment,
          signal: wallController.signal,
          onHandoffDelivered: deps.onHandoffDelivered,
        });
        intermediateStatus.sent = true;
        return true;
      } catch (error) {
        deps.log?.warn("intermediate tool status send failed", {
          error: makeToolErrorText(error),
        });
        return false;
      }
    };
    try {
      timingState.resetAgentLoopStart();
      const mainMessages = deps.actorContinuation?.transcript === undefined
        ? buildInitialMessages(
            userContent,
            volatileMessages,
            msg,
            deps.runtimePrompts,
            model.llmProvider === "openai-codex" ? [] : initialRoles,
            finalActionInstruction,
          )
        : [...deps.actorContinuation.transcript];
      if (deps.actorContinuation !== undefined) {
        mainMessages.push({ role: "user", content: deps.actorContinuation.controlMessage });
      }
      maintenanceTranscript = mainMessages;
      const result = await runNativeToolLoop({
        complete,
        requestBase: {
          provider: model.llmProvider,
          apiKey: baseStreamOptions.apiKey,
          model: model.id,
          systemPrompt: model.llmProvider === "openai-codex"
            ? codexSystemPromptForStableSections(stableSections, transport)
            : "",
          providerParams,
          sessionId,
          promptCacheKey,
          onPayload: (payload: unknown) => {
            if (model.llmProvider === "openrouter") {
              prependStableSectionsToPayload(payload, stableSections, profile.promptCaching, model.id);
            } else if (transport.mode === "split-input") {
              prependStableSectionsToCodexPayload(payload, stableSections, initialRoles, {
                enabled: profile.promptCaching.enabled,
                promptCacheKey,
              });
            }
            reqLog?.recordLLMRequest(payload);
            deps.log?.debug("llm_request_payload", { payload });
          },
        },
        messages: mainMessages,
        tools: timedTools,
        initialToolNames: actorInitialToolNames,
        maxToolCalls: deps.actorContinuation?.maxToolCalls === null
          ? undefined
          : deps.actorContinuation?.maxToolCalls ?? deps.guildConfig.replyLoop.maxToolCalls,
        maxToolRounds: deps.actorContinuation?.maxToolCalls === null
          ? undefined
          : deps.actorContinuation?.maxToolCalls ?? deps.guildConfig.replyLoop.maxToolCalls,
        agentTimeBudgetMs: wallClockTimeoutMs,
        llmOutputTimeoutMs: deps.guildConfig.replyLoop.llmOutputTimeoutMs,
        retryDelayMs: deps.modelTurnRetryDelayMs,
        requestLog: reqLog,
        sendIntermediateText: deps.externalResponseSink !== undefined || deps.disableLiveOutput === true
          ? undefined
          : sendIntermediateStatus,
        streamFinalText: deps.externalResponseSink !== undefined
          ? async (delta) => await deps.externalResponseSink?.push(delta) ?? false
          : deps.disableLiveOutput === true
          ? undefined
          : async (delta, destinationChannelId) => {
            const dispatcher = liveDispatcherFor(destinationChannelId);
            const before = dispatcher.sentCount();
            await dispatcher.push(delta);
            const sent = dispatcher.sentCount() > before;
            if (sent) intermediateStatus.sent = true;
            return sent;
          },
        onModelTurnStart: (destinationChannelId) => {
          deps.externalResponseSink?.startModelTurn();
          liveDispatchers.get(destinationChannelId ?? "")?.startModelTurn();
        },
        onStillWorking: deps.onStillWorking,
        hasExternalVisibleOutput: deps.hasExternalVisibleOutput,
        currentChannelId: deps.currentChannelId,
        imageInputSupported: supportsNativeImageInput(model.input, deps.modelImageInputSupport),
        toolTiming: timingState,
        log: deps.log,
        imageFallback: {
          enabled: deps.guildConfig.imageReading.fallbackEnabled,
          model: imageProfile.model,
          provider: imageProfile.provider,
          apiKey: imageStreamOptions.apiKey,
          providerParams: imageProviderParams,
          complete,
          llmOutputTimeoutMs: deps.guildConfig.replyLoop.llmOutputTimeoutMs,
          imageDescriptionSystemPrompt: deps.runtimePrompts?.imageDescriptionSystemPrompt,
          requestLog: reqLog,
          signal: wallController.signal,
          log: deps.log,
        },
        consumeGeneratedAttachments: deps.consumeGeneratedAttachments,
        pendingAttachments,
        runtimePrompts: deps.runtimePrompts,
        allowEmptyFinalResponse: deps.hasExternalVisibleOutput,
        correctInvalidMessageDirectives: true,
        signal: wallController.signal,
        onActiveToolsChanged: (activeTools) => {
          maintenancePromptContext.activeToolNames = activeTools.map((tool) => tool.name);
          maintenancePromptContext.toolContractSignature = toolContractSignature(activeTools);
        },
        initialLoadedSkillIds: deps.actorContinuation?.loadedSkillIds ?? deps.loadedSkillIds,
        onLoadedSkillsChanged: (skillIds) => {
          maintenancePromptContext.loadedSkillIds = [...skillIds];
        },
        takePendingMessages: deps.actorContinuation?.takePendingMessages,
        stopAfterAsyncImageJobCreated: deps.actorContinuation === undefined,
        beforeModelTurn: deps.actorContinuation === undefined
          ? undefined
          : async (currentMessages) => await compactBackgroundTranscript({
              messages: currentMessages,
              fixedPromptTokens: Math.ceil(stableSections.reduce((chars, section) => chars + section.text.length, 0) / 4),
              model,
              reserveTokens: deps.actorContinuation?.compaction.reserveTokens ?? 16_384,
              keepRecentTokens: deps.actorContinuation?.compaction.keepRecentTokens ?? 20_000,
              complete,
              requestBase: {
                provider: model.llmProvider,
                apiKey: baseStreamOptions.apiKey,
                model: model.id,
                systemPrompt: model.llmProvider === "openai-codex"
                  ? codexSystemPromptForStableSections(stableSections, transport)
                  : "",
                providerParams,
                sessionId,
                promptCacheKey,
              },
              signal: wallController.signal,
              requestLog: reqLog,
              log: deps.log,
            }),
        onActionCommitted: commitModelAction,
      });
      finalText = result.text;
      finalStopReason = result.stopReason;
    } finally {
      clearTimeout(wallTimeout);
      deps.abortSignal?.removeEventListener("abort", onCallerAbort);
    }

    assertActionCanCommit(wallController.signal, "Agent loop aborted before completing its first action.");
    if (finalStopReason === "length") {
      deps.log?.warn("native reply blocked after incomplete model output", {
        stopReason: finalStopReason,
        outputLength: finalText.length,
        visibleOutputAlreadySent: hasVisibleOutput()
          || [...liveDispatchers.values()].some((dispatcher) => dispatcher.sentCount() > 0),
      });
      return { triggered: true, triggerResult, agentRan: true, maintenanceTranscript, availableTools: tools, promptContext: maintenancePromptContext };
    }

    if (deps.externalResponseSink !== undefined) {
      const external = await deps.externalResponseSink.finish(finalText);
      if (external.malformed) {
        deps.log?.warn("external response blocked after malformed private output", {
          outputLength: finalText.length,
        });
      }
      scheduleMemoryPass(external.memoryText, external.visible);
      return {
        triggered: true,
        triggerResult,
        agentRan: true,
        responseText: external.memoryText,
        maintenanceTranscript,
        availableTools: tools,
        promptContext: maintenancePromptContext,
      };
    }

    const parsedResponse = parseResponseDirectives(finalText);
    if (parsedResponse.directiveErrors !== undefined) {
      deps.log?.warn("native reply blocked after invalid message directive", {
        errors: parsedResponse.directiveErrors,
      });
      return { triggered: true, triggerResult, agentRan: true, maintenanceTranscript, availableTools: tools, promptContext: maintenancePromptContext };
    }
    if (parsedResponse.malformedPrivateOutput === true) {
      deps.log?.warn("native reply blocked after malformed private output", {
        outputLength: finalText.length,
      });
      return { triggered: true, triggerResult, agentRan: true, maintenanceTranscript, availableTools: tools, promptContext: maintenancePromptContext };
    }
    const privateThoughts = privateThoughtsFromTranscript(maintenanceTranscript);
    if (parsedResponse.ignored) {
      if (parsedResponse.ignoredText !== undefined) {
        try {
          await deps.onIgnoredReply?.({
            sourceMessageId: msg.messageId,
            channelId: deps.currentChannelId,
            historyText: parsedResponse.ignoredText,
            rawResponse: finalText,
          });
        } catch (error) {
          deps.log?.warn("ignored reply persistence failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      scheduleMemoryPass(parsedResponse.ignoredText ?? finalText, hasVisibleOutput());
      deps.log?.debug("native_reply_ignored", { durationMs: Date.now() - startedAt });
      return {
        triggered: true,
        triggerResult,
        agentRan: true,
        ...(privateThoughts.length > 0 ? { privateThoughts } : {}),
        maintenanceTranscript,
        availableTools: tools,
        promptContext: maintenancePromptContext,
      };
    }
    if (parsedResponse.segments.length === 0) {
      scheduleMemoryPass("", hasVisibleOutput());
      deps.log?.debug("native_reply_empty_after_directives", { durationMs: Date.now() - startedAt });
      return {
        triggered: true,
        triggerResult,
        agentRan: true,
        ...(privateThoughts.length > 0 ? { privateThoughts } : {}),
        maintenanceTranscript,
        availableTools: tools,
        promptContext: maintenancePromptContext,
      };
    }
    assertActionCanCommit(wallController.signal, "Agent loop aborted before final message delivery.");
    commitModelAction();
    if (deps.preSendCheck !== undefined && !await deps.preSendCheck(finalText)) {
      deps.log?.debug("native_reply_dropped_before_send", { durationMs: Date.now() - startedAt });
      return {
        triggered: true,
        triggerResult,
        agentRan: true,
        maintenanceTranscript,
        availableTools: tools,
        promptContext: maintenancePromptContext,
      };
    }

    const liveSent = await (liveDispatchers.get("")?.finish(finalText) ?? Promise.resolve(0));
    if (liveSent === 0) {
      await sendResponseSegments({
        sender: deps.sender,
        generateSpeech: deps.generateSpeech,
        ttsEnabled: deps.ttsEnabled ?? false,
        segments: parsedResponse.segments,
        replyFirst: !hasVisibleOutput() && replyFirst,
        currentChannelId: deps.currentChannelId,
        requestLog: reqLog,
        log: deps.log,
        onStillWorking: deps.onStillWorking,
        getTypingStartedAt: deps.getTypingStartedAt,
        onVisibleOutput: noteVisibleOutput,
        typingHoldMs: liveMessageTypingHoldMs,
        typingHoldMsForSegment,
        signal: wallController.signal.aborted ? undefined : wallController.signal,
        pendingAttachments,
        resolveAssetAttachments: deps.resolveAssetAttachments,
        onHandoffDelivered: deps.onHandoffDelivered,
      });
    }

    const memoryReply = renderSegmentsForMemory(parsedResponse.segments);
    scheduleMemoryPass(memoryReply, hasVisibleOutput());

    deps.log?.debug("native_reply_loop_end", {
      durationMs: Date.now() - startedAt,
      outputLength: memoryReply.length,
    });
    return {
      triggered: true,
      triggerResult,
      agentRan: true,
      responseText: memoryReply,
      ...(privateThoughts.length > 0 ? { privateThoughts } : {}),
      maintenanceTranscript,
      availableTools: tools,
      promptContext: maintenancePromptContext,
    };
  } finally {
    deps.onAgentEnd?.();
  }
}
