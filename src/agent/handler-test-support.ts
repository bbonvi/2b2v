import type { AssembledContext } from "./context-assembly.ts";
import type { GlobalConfig, GuildConfig, PromptTransportConfig } from "../config/types.ts";
import type { RuntimePromptBundle } from "../config/instruction-bundle.ts";
import type { ChatCompleteFn, HandlerDeps, IncomingMessage, MessageSender } from "./turn-types.ts";
import { DEFAULT_AGENT_JOBS, DEFAULT_SEMANTIC_MAINTENANCE } from "../config/defaults.ts";

export const TEST_RUNTIME_PROMPTS = {
  reply: "# Runtime Core\nReserved action directives.",
  backgroundAgent: "## Background Agent Run\nComplete the delegated task before yielding.",
  finalActionInstruction: "## Final Action Instruction\nSend visible output or intentionally stay silent.",
  toolDescriptions: {},
  toolParameterDescriptions: {},
  contextTemplates: {
    "agent-time-budget-exhausted": "Native turn time budget exhausted after {{timeoutMs}}ms; stop tool use.",
    "memory-pass-decision": "Review only strongly implied durable facts. Before adding, check existing memories. Prefer expiresIn for relative expiry.",
    "visible-reply-execution-mode": "## Execution Mode: Visible Reply\nPersona-specific visible mode.",
    "scheduled-task-execution-mode": "## Scheduled Task Context\nPersona-specific scheduled mode.",
  },
  imageDescriptionSystemPrompt: [
    "Describe images for another Discord chat model.",
    "Mention visible race/ethnicity/skin tone only when relevant.",
    "Use normal words like woman when useful.",
    "Call out whether this looks like a selfie, movie/TV/anime/game frame, actor, or vibe.",
  ].join("\n"),
  ambientAttentionEvaluator: {
    shared: "Ambient shared.",
    ambientPickup: "Ambient pickup.",
    lingeringAttention: "Lingering attention.",
    followUp: "Follow up.",
  },
  ambientInitiative: {
    evaluator: "Initiative wake evaluator.",
  },
  relationships: { context: "Relationship context." },
  skills: {
    byId: {
      image_generation: {
        id: "image_generation",
        title: "Image Generation",
        description: "Use for generated images.",
        requiredForTools: ["codex_generate_image"],
        instructionDocuments: [],
        content: "# Skill: Image Generation\nUse the image tool.",
      },
    },
    indexPrompt: "## Skills\n- image_generation: Use for generated images. Required before: codex_generate_image.",
    requiredByTool: { codex_generate_image: "image_generation" },
  },
} satisfies RuntimePromptBundle;

export function makePromptTransportConfig(): PromptTransportConfig {
  return {
    openaiCodex: {
      mode: "split-input",
      sections: {
        system: { role: "developer", target: "instructions", cacheGroup: "core" },
        core: { role: "developer", target: "input", cacheGroup: "core" },
        skills: { role: "developer", target: "input", cacheGroup: "runtime" },
        runtime: { role: "developer", target: "input", cacheGroup: "runtime" },
        stableContext: { role: "user", target: "input", cacheGroup: "stable-context" },
        olderHistory: { role: "user", target: "input", cacheGroup: "older-history" },
        custom: { role: "developer", target: "input", cacheGroup: "custom", content: "" },
        serverMembers: { role: "user", target: "input" },
        threadsInChannel: { role: "user", target: "input" },
        discordContext: { role: "user", target: "input" },
        upcomingSchedules: { role: "user", target: "input" },
        notebooks: { role: "user", target: "input" },
        innerThreads: { role: "developer", target: "input" },
        relationships: { role: "user", target: "input" },
        memories: { role: "user", target: "input" },
        recentHistory: { role: "user", target: "input" },
        currentContext: { role: "user", target: "input" },
        personaMode: { role: "developer", target: "input" },
        responseInstruction: { role: "developer", target: "input" },
        currentTurn: { role: "user", target: "input" },
        finalActionInstruction: { role: "user", target: "input" },
      },
    },
    openrouter: {
      mode: "split-input",
      sections: {
        system: { role: "developer", target: "input", cacheGroup: "core" },
        core: { role: "developer", target: "input", cacheGroup: "core" },
        skills: { role: "developer", target: "input", cacheGroup: "runtime" },
        runtime: { role: "developer", target: "input", cacheGroup: "runtime" },
        stableContext: { role: "user", target: "input", cacheGroup: "stable-context" },
        olderHistory: { role: "user", target: "input", cacheGroup: "older-history" },
        custom: { role: "developer", target: "input", cacheGroup: "custom", content: "" },
        serverMembers: { role: "user", target: "input" },
        threadsInChannel: { role: "user", target: "input" },
        discordContext: { role: "user", target: "input" },
        upcomingSchedules: { role: "user", target: "input" },
        notebooks: { role: "user", target: "input" },
        innerThreads: { role: "developer", target: "input" },
        relationships: { role: "user", target: "input" },
        memories: { role: "user", target: "input" },
        recentHistory: { role: "user", target: "input" },
        currentContext: { role: "user", target: "input" },
        personaMode: { role: "developer", target: "input" },
        responseInstruction: { role: "developer", target: "input" },
        currentTurn: { role: "user", target: "input" },
        finalActionInstruction: { role: "user", target: "input" },
      },
    },
  };
}

export function makeGlobalConfig(overrides: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    discordToken: "test-token",
    openrouterApiKey: "test-key",
    codexAuthPath: "data/codex-auth.json",
    modelProfiles: {
      main: {
        provider: "openrouter",
        model: "moonshotai/kimi-k2.5",
        modelParams: {},
        codexTransport: "websocket-cached",
        promptCaching: { enabled: true },
      },
    },
    defaultModelProfile: "main",
    defaultTimezone: "UTC",
    defaultContextHistory: { retainedMessages: 150, recentMessages: 20, messageCharLimit: 200 },
    defaultTriggers: { mention: true, keywords: [], randomChance: 0, keywordDebounceMs: 2500, typingIdleMs: 10000, typingResumeGraceMs: 3000, typingMaxWaitMs: 15000 },
    defaultMergeMessageGapSeconds: 120,
    defaultImageReferenceMaxPerCall: 10,
    defaultImageReading: { fallbackEnabled: false, fallbackModelProfile: "main" },
    defaultImageGeneration: { quality: "auto", modelProfile: "main" },
    logLevel: "info",
    dataDir: "./data",
    uiLang: "en",
    defaultEmotes: { include: false },
    defaultMembers: { include: true },
    defaultDispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000 },
    defaultTypingSimulation: { enabled: false, inputReadingWpm: 450, inputMinDelayMs: 300, inputMaxDelayMs: 3500, outputTypingWpm: 180, outputMinHoldMs: 700, outputMaxHoldMs: 3500 },
    agentJobs: { ...DEFAULT_AGENT_JOBS, terminalVisibleMs: 600_000 },
    defaultSchedulePressure: { maxRequesterRunsPerHour: 120, maxRequesterRunsPerDay: 500, maxGuildRunsPerHour: 600, maxGuildRunsPerDay: 3000 },
    defaultPromptTransport: makePromptTransportConfig(),
    defaultReplyLoop: { maxToolCalls: 64, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
    defaultMemoryExtraction: {
      modelProfile: "main",
      postReply: true,
      maxToolCalls: 5,
      ambient: { enabled: false, everyMessages: 300, maxBatchMessages: 300, minIntervalSeconds: 600 },
    },
    defaultSemanticMaintenance: DEFAULT_SEMANTIC_MAINTENANCE,
    repertoire: {
      enabled: false,
      lookbackHours: 48,
      refreshMinutes: 240,
      maxSourceChannels: 4,
      maxMessages: 15,
      maxChars: 10_000,
    },
    ...overrides,
  };
}

export function makeCodexGlobal(
  profileOverrides: Partial<GlobalConfig["modelProfiles"][string]> = {},
): GlobalConfig {
  return makeGlobalConfig({
    modelProfiles: {
      main: {
        provider: "openai-codex",
        model: "gpt-5.5",
        modelParams: {},
        codexTransport: "websocket-cached",
        promptCaching: { enabled: true },
        ...profileOverrides,
      },
    },
  });
}

export function makeImageGlobal(
  mainModel: string,
  fallbackParams: Record<string, unknown> = {},
): GlobalConfig {
  return makeGlobalConfig({
    modelProfiles: {
      main: {
        provider: "openrouter",
        model: mainModel,
        modelParams: {},
        codexTransport: "websocket-cached",
        promptCaching: { enabled: true },
      },
      imageFallback: {
        provider: "openrouter",
        model: "moonshotai/kimi-k2.5",
        modelParams: fallbackParams,
        codexTransport: "websocket-cached",
        promptCaching: { enabled: true },
      },
    },
  });
}

export function makeGuildConfig(overrides: Partial<GuildConfig> = {}): GuildConfig {
  return {
    guildId: "guild-1",
    slug: "test",
    triggers: { mention: true, keywords: [], randomChance: 0, keywordDebounceMs: 2500, typingIdleMs: 10000, typingResumeGraceMs: 3000, typingMaxWaitMs: 15000 },
    modelProfile: "main",
    timezone: "UTC",
    contextHistory: { retainedMessages: 150, recentMessages: 20, messageCharLimit: 200 },
    adminUserIds: [],
    mergeMessageGapSeconds: 120,
    imageReferenceMaxPerCall: 10,
    imageReading: { fallbackEnabled: false, fallbackModelProfile: "main" },
    imageGeneration: { quality: "auto", modelProfile: "main" },
    instructions: "",
    emotes: { include: false },
    members: { include: true },
    dispatcher: { enabled: true, mentionDebounceMs: 500, defaultDebounceMs: 2000 },
    typingSimulation: { enabled: false, inputReadingWpm: 450, inputMinDelayMs: 300, inputMaxDelayMs: 3500, outputTypingWpm: 180, outputMinHoldMs: 700, outputMaxHoldMs: 3500 },
    schedulePressure: { maxRequesterRunsPerHour: 120, maxRequesterRunsPerDay: 500, maxGuildRunsPerHour: 600, maxGuildRunsPerDay: 3000 },
    promptTransport: makePromptTransportConfig(),
    replyLoop: { maxToolCalls: 64, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 },
    memoryExtraction: {
      modelProfile: "main",
      postReply: true,
      maxToolCalls: 5,
      ambient: { enabled: false, everyMessages: 300, maxBatchMessages: 300, minIntervalSeconds: 600 },
    },
    semanticMaintenance: DEFAULT_SEMANTIC_MAINTENANCE,
    ...overrides,
  };
}

export function makeContext(overrides: Partial<AssembledContext> = {}): AssembledContext {
  return {
    sections: [
      { label: "Server Members", text: "## Server Members\n@user", cached: false, role: "developer" },
      { label: "Memories", text: "## Memory\n- 1 [@user] [preference] concise", cached: false, role: "developer" },
      { label: "Current Context", text: "Guild: g1", cached: false, role: "developer" },
    ],
    userMessage: "hello bot",
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    content: "hello bot",
    authorId: "user-1",
    authorUsername: "testuser",
    botUserId: "bot-1",
    mentionedUserIds: [],
    mentionedRoleIds: [],
    botRoleIds: [],
    mentionedEveryone: false,
    translatedContent: "hello bot",
    messageId: "msg-1",
    ...overrides,
  };
}

export function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  const sender: MessageSender = () => Promise.resolve({ sentMessageId: "sent-1" });
  const completeChat: ChatCompleteFn = () => Promise.resolve({
    text: "hello user",
    toolCalls: [],
    rawResponse: {},
    messageForLogs: {
      role: "assistant",
      model: "m",
      stopReason: "stop",
      content: [{ type: "text", text: "hello user" }],
      usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
    },
  });

  const initialToolNames = overrides.initialToolNames
    ?? overrides.extraTools?.map((tool) => tool.name);
  return {
    globalConfig: makeGlobalConfig(),
    guildConfig: makeGuildConfig(),
    context: makeContext(),
    currentChannelId: "channel-1",
    personaPrompt: "You are a test bot.",
    runtimePrompts: TEST_RUNTIME_PROMPTS,
    sender,
    completeChat,
    liveMessageTypingHoldMs: 0,
    modelTurnRetryDelayMs: () => 0,
    ...(initialToolNames !== undefined ? { initialToolNames } : {}),
    ...overrides,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function payloadText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return "";
  const chunks: string[] = [];
  for (const message of payload.messages) {
    if (!isRecord(message)) continue;
    const content = message.content;
    if (typeof content === "string") {
      chunks.push(content);
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      if (typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n");
}

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("");
}

export function findMessageContent(messages: Array<{ content?: unknown }>, needle: string): string | undefined {
  return messages.map((message) => contentText(message.content)).find((content) => content.includes(needle));
}

export function makeModelTimeoutError(timeoutMs = 12_000): Error {
  const error = new Error(`LLM output timed out after ${timeoutMs}ms`);
  error.name = "ModelOutputTimeoutError";
  return error;
}
