import { parse, stringify } from "yaml";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "fs";
import { join, basename } from "path";
import type {
  GlobalConfig,
  GuildConfig,
  GuildConfigYaml,
  MainConfigYaml,
  TriggerConfig,
  TriggerInstructions,
  TrimConfig,
  ThinkingLevel,
  UiLang,
  VpnConfig,
  EmotesConfig,
  MembersConfig,
  DispatcherConfig,
  AgentJobsConfig,
  PromptCachingConfig,
  PromptTransportConfig,
  PromptTransportConfigYaml,
  ProviderPromptTransportConfigYaml,
  CodexPromptTransportMode,
  PromptTransportRole,
  PromptTransportSectionConfig,
  PromptTransportSectionId,
  PromptTransportTarget,
  BackgroundLlmConfig,
  BackgroundLlmDefaults,
  ImageReadingConfig,
  ImageGenerationConfig,
  ImageGenerationQuality,
  ReplyLoopConfig,
  MemoryExtractionConfig,
  ServiceTier,
  LlmProvider,
} from "./types.ts";
import type { TextNormalizationMode, TtsConfig, VoicePreset } from "../tts/types.ts";

const DEFAULT_TRIGGER: TriggerConfig = {
  mention: true,
  keywords: [],
  randomChance: 0,
  keywordDebounceMs: 2500,
  typingIdleMs: 10000,
  typingMaxWaitMs: 15000,
};

const DEFAULT_TRIM: TrimConfig = {
  trimTrigger: 200,
  trimTarget: 150,
  windowSize: 20,
  messageCharLimit: 200,
  replyQuoteChars: 50,
};

const DEFAULT_MEMORY_EXTRACTION: MemoryExtractionConfig = {
  postReply: true,
  ambient: {
    enabled: false,
    everyMessages: 300,
    maxBatchMessages: 300,
    minIntervalSeconds: 600,
  },
};

/** Default voice preset values for TTS. */
const DEFAULT_VOICE_PRESET: VoicePreset = {
  voiceId: "",
  speed: 1.0,
  stability: 0.5,
  similarityBoost: 0.75,
  style: 0,
  useSpeakerBoost: false,
  model: "eleven_v3",
};

function resolveTextNormalizationMode(
  value: unknown,
): TextNormalizationMode | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "on" || value === "off") return value;
  throw new Error('tts.voices.normal.applyTextNormalization must be "auto", "on", or "off"');
}

/**
 * Resolve a partial VoicePreset from YAML against defaults.
 * Returns undefined if voiceId is not set (required field).
 */
function resolveVoicePreset(partial: Partial<VoicePreset> | undefined): VoicePreset | undefined {
  if (partial === undefined || partial.voiceId === undefined || partial.voiceId === "") {
    return undefined;
  }
  return {
    voiceId: partial.voiceId,
    speed: partial.speed ?? DEFAULT_VOICE_PRESET.speed,
    stability: partial.stability ?? DEFAULT_VOICE_PRESET.stability,
    similarityBoost: partial.similarityBoost ?? DEFAULT_VOICE_PRESET.similarityBoost,
    style: partial.style ?? DEFAULT_VOICE_PRESET.style,
    useSpeakerBoost: partial.useSpeakerBoost ?? DEFAULT_VOICE_PRESET.useSpeakerBoost,
    ...(partial.seed !== undefined ? { seed: partial.seed } : {}),
    ...(partial.applyTextNormalization !== undefined
      ? { applyTextNormalization: resolveTextNormalizationMode(partial.applyTextNormalization) }
      : {}),
    ...(partial.outputFormat !== undefined && partial.outputFormat.trim() !== ""
      ? { outputFormat: partial.outputFormat.trim() }
      : {}),
    model: partial.model ?? DEFAULT_VOICE_PRESET.model,
  };
}

/**
 * Resolve TTS config from YAML partial.
 * Returns undefined if TTS is not enabled or no normal voice is configured.
 */
function resolveTtsConfig(
  partial: MainConfigYaml["tts"] | GuildConfigYaml["tts"] | undefined
): TtsConfig | undefined {
  if (partial === undefined) return undefined;
  if (partial.enabled !== true) return undefined;

  const normalVoice = resolveVoicePreset(partial.voices?.normal);
  if (normalVoice === undefined) return undefined;

  return {
    enabled: true,
    voices: {
      normal: normalVoice,
    },
  };
}

/**
 * Resolve VPN config from YAML partial.
 * Returns undefined if VPN is not enabled.
 */
function resolveVpnConfig(
  partial: MainConfigYaml["vpn"] | undefined
): VpnConfig | undefined {
  if (partial?.enabled !== true) return undefined;
  return {
    enabled: true,
    apiUrl: partial.apiUrl ?? "",
    vpnPeer: partial.vpnPeer ?? "",
  };
}

/**
 * Validate VPN config. Throws if enabled but missing required fields.
 */
export function validateVpnConfig(vpn: VpnConfig | undefined): void {
  if (vpn === undefined || !vpn.enabled) return;
  if (vpn.apiUrl === "") throw new Error("vpn.apiUrl required when vpn.enabled");
  if (vpn.vpnPeer === "") throw new Error("vpn.vpnPeer required when vpn.enabled");
}

const DEFAULT_EMOTES: EmotesConfig = {
  include: false,
};

const DEFAULT_MEMBERS: MembersConfig = {
  include: true,
};

const DEFAULT_DISPATCHER: DispatcherConfig = {
  enabled: true,
  mentionDebounceMs: 500,
  defaultDebounceMs: 2000,
};

const DEFAULT_AGENT_JOBS: AgentJobsConfig = {
  imageTimeoutMs: 300_000,
  imageCancelGraceMs: 60_000,
  terminalVisibleMs: 600_000,
  maxImageReplacements: 2,
};

const DEFAULT_PROMPT_CACHING: PromptCachingConfig = {
  enabled: true,
};

const DEFAULT_LLM_PROVIDER: LlmProvider = "openrouter";

const DEFAULT_IMAGE_READING: ImageReadingConfig = {
  fallbackEnabled: false,
  fallbackProvider: "openrouter",
  fallbackModel: "moonshotai/kimi-k2.5",
  fallbackModelParams: {},
};

const DEFAULT_IMAGE_GENERATION: ImageGenerationConfig = {
  quality: "auto",
};

const DEFAULT_REPLY_LOOP: ReplyLoopConfig = {
  maxToolCalls: 64,
  wallClockTimeoutMs: 45_000,
  llmOutputTimeoutMs: 12_000,
};

const PROMPT_TRANSPORT_SECTION_IDS: readonly PromptTransportSectionId[] = [
  "core",
  "skills",
  "runtime",
  "stableContext",
  "olderHistory",
  "serverMembers",
  "threadsInChannel",
  "discordContext",
  "upcomingSchedules",
  "memories",
  "recentHistory",
  "currentContext",
  "responseInstruction",
  "currentTurn",
] as const;

const DEFAULT_PROMPT_TRANSPORT: PromptTransportConfig = {
  openaiCodex: {
    mode: "split-input",
    sections: {
      core: { role: "developer", target: "input", cacheGroup: "core" },
      skills: { role: "developer", target: "input", cacheGroup: "runtime" },
      runtime: { role: "developer", target: "input", cacheGroup: "runtime" },
      stableContext: { role: "user", target: "input", cacheGroup: "stable-context" },
      olderHistory: { role: "user", target: "input", cacheGroup: "older-history" },
      serverMembers: { role: "user", target: "input" },
      threadsInChannel: { role: "user", target: "input" },
      discordContext: { role: "user", target: "input" },
      upcomingSchedules: { role: "user", target: "input" },
      memories: { role: "user", target: "input" },
      recentHistory: { role: "user", target: "input" },
      currentContext: { role: "user", target: "input" },
      responseInstruction: { role: "developer", target: "input" },
      currentTurn: { role: "user", target: "input" },
    },
  },
  openrouter: {
    mode: "split-input",
    sections: {
      core: { role: "developer", target: "input", cacheGroup: "core" },
      skills: { role: "developer", target: "input", cacheGroup: "runtime" },
      runtime: { role: "developer", target: "input", cacheGroup: "runtime" },
      stableContext: { role: "user", target: "input", cacheGroup: "stable-context" },
      olderHistory: { role: "user", target: "input", cacheGroup: "older-history" },
      serverMembers: { role: "user", target: "input" },
      threadsInChannel: { role: "user", target: "input" },
      discordContext: { role: "user", target: "input" },
      upcomingSchedules: { role: "user", target: "input" },
      memories: { role: "user", target: "input" },
      recentHistory: { role: "user", target: "input" },
      currentContext: { role: "user", target: "input" },
      responseInstruction: { role: "developer", target: "input" },
      currentTurn: { role: "user", target: "input" },
    },
  },
};

function resolveGlobalPromptCaching(
  partial: MainConfigYaml["promptCaching"] | undefined
): PromptCachingConfig {
  return {
    enabled: partial?.enabled ?? DEFAULT_PROMPT_CACHING.enabled,
  };
}

function clonePromptTransport(config: PromptTransportConfig): PromptTransportConfig {
  return {
    openaiCodex: {
      mode: config.openaiCodex.mode,
      sections: Object.fromEntries(
        PROMPT_TRANSPORT_SECTION_IDS.map((id) => [id, { ...config.openaiCodex.sections[id] }]),
      ) as Record<PromptTransportSectionId, PromptTransportSectionConfig>,
    },
    openrouter: {
      mode: config.openrouter.mode,
      sections: Object.fromEntries(
        PROMPT_TRANSPORT_SECTION_IDS.map((id) => [id, { ...config.openrouter.sections[id] }]),
      ) as Record<PromptTransportSectionId, PromptTransportSectionConfig>,
    },
  };
}

function parsePromptTransportRole(value: unknown, key: string): PromptTransportRole | undefined {
  if (value === undefined) return undefined;
  if (value === "system" || value === "developer" || value === "user") return value;
  throw new Error(`${key} must be "system", "developer", or "user"`);
}

function parsePromptTransportTarget(value: unknown, key: string): PromptTransportTarget | undefined {
  if (value === undefined) return undefined;
  if (value === "instructions" || value === "input") return value;
  throw new Error(`${key} must be "instructions" or "input"`);
}

function parseCodexPromptTransportMode(value: unknown, key: string): CodexPromptTransportMode | undefined {
  if (value === undefined) return undefined;
  if (value === "legacy-instructions" || value === "split-input") return value;
  throw new Error(`${key}.mode must be "legacy-instructions" or "split-input"`);
}

function validatePromptTransportSectionKeys(
  sections: ProviderPromptTransportConfigYaml["sections"] | undefined,
  key: string,
): void {
  if (sections === undefined) return;
  const allowed = new Set<string>(PROMPT_TRANSPORT_SECTION_IDS);
  for (const sectionId of Object.keys(sections)) {
    if (!allowed.has(sectionId)) {
      throw new Error(`${key}.sections.${sectionId} is not a known prompt transport section`);
    }
  }
}

function resolveProviderPromptTransport(
  base: PromptTransportConfig["openaiCodex"],
  partial: ProviderPromptTransportConfigYaml | undefined,
  key: string,
): PromptTransportConfig["openaiCodex"] {
  validatePromptTransportSectionKeys(partial?.sections, key);
  const sections = Object.fromEntries(
    PROMPT_TRANSPORT_SECTION_IDS.map((id) => {
      const baseSection = base.sections[id];
      const partialSection = partial?.sections?.[id];
      return [id, {
        role: parsePromptTransportRole(partialSection?.role, `${key}.sections.${id}.role`) ?? baseSection.role,
        target: parsePromptTransportTarget(partialSection?.target, `${key}.sections.${id}.target`) ?? baseSection.target,
        cacheGroup: partialSection?.cacheGroup ?? baseSection.cacheGroup,
      }];
    }),
  ) as Record<PromptTransportSectionId, PromptTransportSectionConfig>;

  return {
    mode: parseCodexPromptTransportMode(partial?.mode, key) ?? base.mode,
    sections,
  };
}

function resolveGlobalPromptTransport(
  partial: PromptTransportConfigYaml | undefined,
): PromptTransportConfig {
  const defaults = clonePromptTransport(DEFAULT_PROMPT_TRANSPORT);
  return {
    openaiCodex: resolveProviderPromptTransport(defaults.openaiCodex, partial?.openaiCodex, "promptTransport.openaiCodex"),
    openrouter: resolveProviderPromptTransport(defaults.openrouter, partial?.openrouter, "promptTransport.openrouter"),
  };
}

function resolveGuildPromptTransport(
  global: PromptTransportConfig,
  partial: PromptTransportConfigYaml | undefined,
): PromptTransportConfig {
  return {
    openaiCodex: resolveProviderPromptTransport(global.openaiCodex, partial?.openaiCodex, "promptTransport.openaiCodex"),
    openrouter: resolveProviderPromptTransport(global.openrouter, partial?.openrouter, "promptTransport.openrouter"),
  };
}

function resolveGlobalImageReading(
  partial: MainConfigYaml["imageReading"] | undefined,
): ImageReadingConfig {
  return {
    fallbackEnabled: partial?.fallbackEnabled ?? DEFAULT_IMAGE_READING.fallbackEnabled,
    fallbackProvider: parseLlmProvider(partial?.fallbackProvider, "imageReading.fallbackProvider")
      ?? DEFAULT_IMAGE_READING.fallbackProvider,
    fallbackModel: partial?.fallbackModel ?? DEFAULT_IMAGE_READING.fallbackModel,
    fallbackModelParams: partial?.fallbackModelParams ?? {},
  };
}

function resolveGuildImageReading(
  global: ImageReadingConfig,
  partial: GuildConfigYaml["imageReading"] | undefined,
): ImageReadingConfig {
  return {
    fallbackEnabled: partial?.fallbackEnabled ?? global.fallbackEnabled,
    fallbackProvider: parseLlmProvider(partial?.fallbackProvider, "imageReading.fallbackProvider") ?? global.fallbackProvider,
    fallbackModel: partial?.fallbackModel ?? global.fallbackModel,
    fallbackModelParams: {
      ...global.fallbackModelParams,
      ...partial?.fallbackModelParams,
    },
  };
}

function parseImageGenerationQuality(value: unknown, key: string): ImageGenerationQuality | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "low" || value === "medium" || value === "high") return value;
  throw new Error(`${key} must be "auto", "low", "medium", or "high"`);
}

function resolveGlobalImageGeneration(
  partial: MainConfigYaml["imageGeneration"] | undefined,
): ImageGenerationConfig {
  return {
    quality: parseImageGenerationQuality(partial?.quality, "imageGeneration.quality")
      ?? DEFAULT_IMAGE_GENERATION.quality,
  };
}

function resolveGuildImageGeneration(
  global: ImageGenerationConfig,
  partial: GuildConfigYaml["imageGeneration"] | undefined,
): ImageGenerationConfig {
  return {
    quality: parseImageGenerationQuality(partial?.quality, "imageGeneration.quality") ?? global.quality,
  };
}

function resolveGuildPromptCaching(
  global: PromptCachingConfig,
  partial: GuildConfigYaml["promptCaching"] | undefined
): PromptCachingConfig {
  return {
    enabled: partial?.enabled ?? global.enabled,
  };
}

function parseLlmProvider(value: unknown, key: string): LlmProvider | undefined {
  if (value === undefined) return undefined;
  if (value === "openrouter" || value === "openai-codex") return value;
  throw new Error(`${key} must be "openrouter" or "openai-codex"`);
}

function parseThinkingLevel(value: unknown, key: string): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (
    value === "minimal"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
  ) {
    return value;
  }
  throw new Error(`${key} must be "minimal", "low", "medium", "high", or "xhigh"`);
}

function parseServiceTier(value: unknown, keyPrefix: string): ServiceTier | undefined {
  if (value === undefined) return undefined;
  if (value === "flex" || value === "priority") return value;
  throw new Error(`${keyPrefix}.serviceTier must be "flex" or "priority"`);
}

function resolveBackgroundPromptCaching(
  fallback: PromptCachingConfig,
  partial: { enabled?: boolean } | undefined,
): PromptCachingConfig {
  return { enabled: partial?.enabled ?? fallback.enabled };
}

function resolveGlobalBackgroundLlm(
  partial: MainConfigYaml["backgroundLlm"] | undefined,
): BackgroundLlmDefaults {
  return {
    provider: parseLlmProvider(partial?.provider, "backgroundLlm.provider"),
    model: partial?.model,
    modelParams: partial?.modelParams ?? {},
    thinkingLevel: parseThinkingLevel(partial?.thinkingLevel, "backgroundLlm.thinkingLevel"),
    serviceTier: parseServiceTier(partial?.serviceTier, "backgroundLlm"),
    promptCaching: partial?.promptCaching !== undefined
      ? resolveBackgroundPromptCaching(DEFAULT_PROMPT_CACHING, partial.promptCaching)
      : undefined,
  };
}

function resolveGuildBackgroundLlm(
  global: GlobalConfig,
  partial: GuildConfigYaml & { guildId: string; slug: string },
  mainPromptCaching: PromptCachingConfig,
): BackgroundLlmConfig {
  const globalBackground = global.defaultBackgroundLlm;
  const guildBackground = partial.backgroundLlm;
  const mainModelParams = { ...global.defaultModelParams, ...partial.modelParams };
  const promptCachingFallback = globalBackground.promptCaching ?? mainPromptCaching;
  const mainProvider = parseLlmProvider(partial.llmProvider, "llmProvider") ?? global.defaultLlmProvider;
  return {
    provider: parseLlmProvider(guildBackground?.provider, "backgroundLlm.provider")
      ?? globalBackground.provider
      ?? mainProvider,
    model: guildBackground?.model ?? globalBackground.model ?? partial.model ?? global.defaultModel,
    modelParams: {
      ...mainModelParams,
      ...globalBackground.modelParams,
      ...guildBackground?.modelParams,
    },
    thinkingLevel: parseThinkingLevel(guildBackground?.thinkingLevel, "backgroundLlm.thinkingLevel")
      ?? globalBackground.thinkingLevel
      ?? parseThinkingLevel(partial.thinkingLevel, "thinkingLevel")
      ?? global.defaultThinkingLevel,
    serviceTier: parseServiceTier(guildBackground?.serviceTier, "backgroundLlm") ?? globalBackground.serviceTier,
    promptCaching: resolveBackgroundPromptCaching(promptCachingFallback, guildBackground?.promptCaching),
  };
}

function resolveGlobalReplyLoop(
  partial: MainConfigYaml["replyLoop"] | undefined
): ReplyLoopConfig {
  const resolved = {
    maxToolCalls: partial?.maxToolCalls ?? DEFAULT_REPLY_LOOP.maxToolCalls,
    wallClockTimeoutMs: partial?.wallClockTimeoutMs ?? DEFAULT_REPLY_LOOP.wallClockTimeoutMs,
    llmOutputTimeoutMs: partial?.llmOutputTimeoutMs ?? DEFAULT_REPLY_LOOP.llmOutputTimeoutMs,
  };
  validateReplyLoopConfig(resolved, "replyLoop");
  return resolved;
}

function resolveGuildReplyLoop(
  global: ReplyLoopConfig,
  partial: GuildConfigYaml["replyLoop"] | undefined
): ReplyLoopConfig {
  const resolved = {
    maxToolCalls: partial?.maxToolCalls ?? global.maxToolCalls,
    wallClockTimeoutMs: partial?.wallClockTimeoutMs ?? global.wallClockTimeoutMs,
    llmOutputTimeoutMs: partial?.llmOutputTimeoutMs ?? global.llmOutputTimeoutMs,
  };
  validateReplyLoopConfig(resolved, "replyLoop");
  return resolved;
}

function validateReplyLoopConfig(config: ReplyLoopConfig, keyPrefix: string): void {
  if (!Number.isFinite(config.maxToolCalls) || config.maxToolCalls < 1) {
    throw new Error(`${keyPrefix}.maxToolCalls must be >= 1`);
  }
  if (!Number.isFinite(config.wallClockTimeoutMs) || config.wallClockTimeoutMs < 1000) {
    throw new Error(`${keyPrefix}.wallClockTimeoutMs must be >= 1000`);
  }
  if (!Number.isFinite(config.llmOutputTimeoutMs) || config.llmOutputTimeoutMs < 1000) {
    throw new Error(`${keyPrefix}.llmOutputTimeoutMs must be >= 1000`);
  }
}

function resolveGlobalMemoryExtraction(
  partial: MainConfigYaml["memoryExtraction"] | undefined,
): MemoryExtractionConfig {
  const resolved = {
    postReply: partial?.postReply ?? DEFAULT_MEMORY_EXTRACTION.postReply,
    ambient: {
      enabled: partial?.ambient?.enabled ?? DEFAULT_MEMORY_EXTRACTION.ambient.enabled,
      everyMessages: partial?.ambient?.everyMessages ?? DEFAULT_MEMORY_EXTRACTION.ambient.everyMessages,
      maxBatchMessages: partial?.ambient?.maxBatchMessages ?? DEFAULT_MEMORY_EXTRACTION.ambient.maxBatchMessages,
      minIntervalSeconds: partial?.ambient?.minIntervalSeconds ?? DEFAULT_MEMORY_EXTRACTION.ambient.minIntervalSeconds,
    },
  };
  validateMemoryExtractionConfig(resolved, "memoryExtraction");
  return resolved;
}

function resolveGuildMemoryExtraction(
  global: MemoryExtractionConfig,
  partial: GuildConfigYaml["memoryExtraction"] | undefined,
): MemoryExtractionConfig {
  const resolved = {
    postReply: partial?.postReply ?? global.postReply,
    ambient: {
      enabled: partial?.ambient?.enabled ?? global.ambient.enabled,
      everyMessages: partial?.ambient?.everyMessages ?? global.ambient.everyMessages,
      maxBatchMessages: partial?.ambient?.maxBatchMessages ?? global.ambient.maxBatchMessages,
      minIntervalSeconds: partial?.ambient?.minIntervalSeconds ?? global.ambient.minIntervalSeconds,
    },
  };
  validateMemoryExtractionConfig(resolved, "memoryExtraction");
  return resolved;
}

function validateMemoryExtractionConfig(config: MemoryExtractionConfig, keyPrefix: string): void {
  if (!Number.isInteger(config.ambient.everyMessages) || config.ambient.everyMessages < 1) {
    throw new Error(`${keyPrefix}.ambient.everyMessages must be >= 1`);
  }
  if (!Number.isInteger(config.ambient.maxBatchMessages) || config.ambient.maxBatchMessages < 1) {
    throw new Error(`${keyPrefix}.ambient.maxBatchMessages must be >= 1`);
  }
  if (!Number.isFinite(config.ambient.minIntervalSeconds) || config.ambient.minIntervalSeconds < 0) {
    throw new Error(`${keyPrefix}.ambient.minIntervalSeconds must be >= 0`);
  }
}

function resolveGlobalAgentJobs(
  partial: MainConfigYaml["agentJobs"] | undefined,
): AgentJobsConfig {
  const resolved = {
    imageTimeoutMs: partial?.imageTimeoutMs ?? DEFAULT_AGENT_JOBS.imageTimeoutMs,
    imageCancelGraceMs: partial?.imageCancelGraceMs ?? DEFAULT_AGENT_JOBS.imageCancelGraceMs,
    terminalVisibleMs: partial?.terminalVisibleMs ?? DEFAULT_AGENT_JOBS.terminalVisibleMs,
    maxImageReplacements: partial?.maxImageReplacements ?? DEFAULT_AGENT_JOBS.maxImageReplacements,
  };
  validateAgentJobsConfig(resolved, "agentJobs");
  return resolved;
}

function resolveGuildAgentJobs(
  global: AgentJobsConfig,
  partial: GuildConfigYaml["agentJobs"] | undefined,
): AgentJobsConfig {
  const resolved = {
    imageTimeoutMs: partial?.imageTimeoutMs ?? global.imageTimeoutMs,
    imageCancelGraceMs: partial?.imageCancelGraceMs ?? global.imageCancelGraceMs,
    terminalVisibleMs: partial?.terminalVisibleMs ?? global.terminalVisibleMs,
    maxImageReplacements: partial?.maxImageReplacements ?? global.maxImageReplacements,
  };
  validateAgentJobsConfig(resolved, "agentJobs");
  return resolved;
}

function validateAgentJobsConfig(config: AgentJobsConfig, keyPrefix: string): void {
  if (!Number.isFinite(config.imageTimeoutMs) || config.imageTimeoutMs < 10_000) {
    throw new Error(`${keyPrefix}.imageTimeoutMs must be >= 10000`);
  }
  if (!Number.isFinite(config.imageCancelGraceMs) || config.imageCancelGraceMs < 0) {
    throw new Error(`${keyPrefix}.imageCancelGraceMs must be >= 0`);
  }
  if (!Number.isFinite(config.terminalVisibleMs) || config.terminalVisibleMs < 0) {
    throw new Error(`${keyPrefix}.terminalVisibleMs must be >= 0`);
  }
  if (!Number.isInteger(config.maxImageReplacements) || config.maxImageReplacements < 0) {
    throw new Error(`${keyPrefix}.maxImageReplacements must be >= 0`);
  }
}

/**
 * Load and parse the main config YAML file.
 * Returns an empty object if the file does not exist.
 * Throws on malformed YAML.
 */
export function loadMainConfig(configPath: string = "config/config.yaml"): MainConfigYaml {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, "utf-8");
  return (parse(raw) ?? {}) as MainConfigYaml;
}

/**
 * Read an instructions file, returning its trimmed content.
 * Returns empty string if the path is empty or the file does not exist.
 */
export function readInstructionsFile(filePath: string): string {
  if (filePath === "") return "";
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf-8").trim();
}

/**
 * Resolve instructions from inline text and/or file path.
 * instructionsPath takes priority over inline instructions.
 * Returns empty string if neither is set.
 */
export function resolveInstructions(
  instructions: string | undefined,
  instructionsPath: string | undefined,
): string {
  if (instructionsPath !== undefined && instructionsPath !== "") {
    const fromFile = readInstructionsFile(instructionsPath);
    if (fromFile !== "") return fromFile;
  }
  return instructions ?? "";
}

function assertNoDeprecatedGlobalPromptKeys(yaml: MainConfigYaml): void {
  const raw = yaml as Record<string, unknown>;
  const deprecatedKeys = ["personaPath", "toolInstructionsPath", "instructionsPath", "instructions"] as const;
  for (const key of deprecatedKeys) {
    if (raw[key] !== undefined) {
      throw new Error(`Deprecated config key "${key}" is no longer supported. Put prompt markdown in prompts/ instead.`);
    }
  }
}

function assertNoDeprecatedReplyLoopKey(yaml: MainConfigYaml | GuildConfigYaml, scope: string): void {
  const raw = yaml as Record<string, unknown>;
  if (raw.actionLoop !== undefined) {
    throw new Error(`Deprecated config key "${scope}.actionLoop" is no longer supported. Use ${scope}.replyLoop instead.`);
  }
}

/**
 * Build global config from main YAML config + env vars.
 * YAML provides non-secret defaults; env vars provide secrets and infrastructure overrides.
 * Throws if required secrets are missing.
 */
export function loadGlobalConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  configPath: string = "config/config.yaml",
): GlobalConfig {
  const discordToken = env.DISCORD_TOKEN;
  if (discordToken === undefined || discordToken === "") throw new Error("DISCORD_TOKEN is required");

  const yaml = loadMainConfig(configPath);
  assertNoDeprecatedGlobalPromptKeys(yaml);
  assertNoDeprecatedReplyLoopKey(yaml, "global");

  const dataDir = yaml.dataDir ?? "data";
  const defaultLlmProvider = parseLlmProvider(yaml.llmProvider, "llmProvider") ?? DEFAULT_LLM_PROVIDER;
  const defaultImageReading = resolveGlobalImageReading(yaml.imageReading);
  const defaultImageGeneration = resolveGlobalImageGeneration(yaml.imageGeneration);
  const openrouterApiKey = env.OPENROUTER_API_KEY;
  const usesOpenRouter = defaultLlmProvider === "openrouter"
    || yaml.backgroundLlm?.provider === "openrouter"
    || (defaultImageReading.fallbackEnabled && defaultImageReading.fallbackProvider === "openrouter");
  if (usesOpenRouter && (openrouterApiKey === undefined || openrouterApiKey === "")) {
    throw new Error("OPENROUTER_API_KEY is required when any OpenRouter LLM backend is enabled");
  }

  const defaultAttachmentsDir = yaml.attachmentsDir ?? `${dataDir}/attachments`;

  return {
    discordToken,
    ...(openrouterApiKey !== undefined && openrouterApiKey !== "" ? { openrouterApiKey } : {}),
    codexAuthPath: env.CODEX_AUTH_PATH ?? `${dataDir}/codex-auth.json`,
    braveApiKey: env.BRAVE_API_KEY,
    defaultLlmProvider,
    defaultModel: yaml.model ?? "moonshotai/kimi-k2.5",
    defaultModelParams: yaml.modelParams ?? {},
    defaultThinkingLevel: parseThinkingLevel(yaml.thinkingLevel, "thinkingLevel"),
    defaultTimezone: yaml.timezone ?? "UTC",
    defaultTrim: {
      trimTrigger: yaml.trim?.trimTrigger ?? DEFAULT_TRIM.trimTrigger,
      trimTarget: yaml.trim?.trimTarget ?? DEFAULT_TRIM.trimTarget,
      windowSize: yaml.trim?.windowSize ?? DEFAULT_TRIM.windowSize,
      messageCharLimit: yaml.trim?.messageCharLimit ?? DEFAULT_TRIM.messageCharLimit,
      replyQuoteChars: yaml.trim?.replyQuoteChars ?? DEFAULT_TRIM.replyQuoteChars,
    },
    defaultTriggers: {
      mention: yaml.triggers?.mention ?? DEFAULT_TRIGGER.mention,
      keywords: yaml.triggers?.keywords ?? [...DEFAULT_TRIGGER.keywords],
      randomChance: yaml.triggers?.randomChance ?? DEFAULT_TRIGGER.randomChance,
      keywordDebounceMs: yaml.triggers?.keywordDebounceMs ?? DEFAULT_TRIGGER.keywordDebounceMs,
      typingIdleMs: yaml.triggers?.typingIdleMs ?? DEFAULT_TRIGGER.typingIdleMs,
      typingMaxWaitMs: yaml.triggers?.typingMaxWaitMs ?? DEFAULT_TRIGGER.typingMaxWaitMs,
    },
    defaultTriggerInstructions: {
      mention: yaml.triggerInstructions?.mention,
      keyword: yaml.triggerInstructions?.keyword,
      random: yaml.triggerInstructions?.random,
      scheduled: yaml.triggerInstructions?.scheduled,
    },
    defaultImageMaxDimension: yaml.imageMaxDimension ?? 4096,
    defaultMergeMessageGapSeconds: yaml.mergeMessageGapSeconds ?? 120,
    defaultImageReadMaxPerCall: yaml.imageReadMaxPerCall ?? 10,
    defaultImageCaptioningEnabled: yaml.imageCaptioningEnabled ?? false,
    defaultImageReading,
    defaultImageGeneration,
    defaultAttachmentsDir,
    defaultInstructions: "",
    logLevel: yaml.logLevel ?? "info",
    dataDir,
    modelCacheDir: yaml.modelCacheDir ?? "model-cache",
    qdrantUrl: env.QDRANT_URL ?? yaml.qdrantUrl ?? "http://localhost:6333",
    elevenLabsApiKey: env.ELEVENLABS_API_KEY,
    defaultTts: resolveTtsConfig(yaml.tts),
    uiLang: (yaml.uiLang === "ru" ? "ru" : "en") as UiLang,
    vpn: resolveVpnConfig(yaml.vpn),
    defaultEmotes: {
      include: yaml.emotes?.include ?? DEFAULT_EMOTES.include,
    },
    defaultMembers: {
      include: yaml.members?.include ?? DEFAULT_MEMBERS.include,
    },
    defaultDispatcher: {
      enabled: yaml.dispatcher?.enabled ?? DEFAULT_DISPATCHER.enabled,
      mentionDebounceMs: yaml.dispatcher?.mentionDebounceMs ?? DEFAULT_DISPATCHER.mentionDebounceMs,
      defaultDebounceMs: yaml.dispatcher?.defaultDebounceMs ?? DEFAULT_DISPATCHER.defaultDebounceMs,
    },
    defaultAgentJobs: resolveGlobalAgentJobs(yaml.agentJobs),
    defaultPromptCaching: resolveGlobalPromptCaching(yaml.promptCaching),
    defaultPromptTransport: resolveGlobalPromptTransport(yaml.promptTransport),
    defaultBackgroundLlm: resolveGlobalBackgroundLlm(yaml.backgroundLlm),
    defaultReplyLoop: resolveGlobalReplyLoop(yaml.replyLoop),
    defaultMemoryExtraction: resolveGlobalMemoryExtraction(yaml.memoryExtraction),
  };
}

/** Parse guild id and slug from filename like `123456-my-server.yaml`. */
function parseGuildFilename(filename: string): { guildId: string; slug: string } {
  const stem = filename.replace(/\.ya?ml$/, "");
  const dashIdx = stem.indexOf("-");
  if (dashIdx === -1) {
    return { guildId: stem, slug: "" };
  }
  return { guildId: stem.slice(0, dashIdx), slug: stem.slice(dashIdx + 1) };
}

/**
 * Load a single guild YAML file. Returns a partial config with guildId and slug
 * extracted from the filename.
 */
export function loadGuildConfigFile(
  filePath: string
): GuildConfigYaml & { guildId: string; slug: string } {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = (parse(raw) ?? {}) as GuildConfigYaml;
  assertNoDeprecatedReplyLoopKey(parsed, "guild");
  const { guildId, slug } = parseGuildFilename(basename(filePath));
  return { guildId, slug, ...parsed };
}

/** Merge a guild partial onto global defaults to produce a fully resolved GuildConfig. */
export function resolveGuildConfig(
  global: GlobalConfig,
  partial: GuildConfigYaml & { guildId: string; slug: string }
): GuildConfig {
  const instructions = resolveInstructions(partial.instructions, partial.instructionsPath);
  const promptCaching = resolveGuildPromptCaching(global.defaultPromptCaching, partial.promptCaching);

  return {
    guildId: partial.guildId,
    slug: partial.slug,
    triggers: {
      mention: partial.triggers?.mention ?? global.defaultTriggers.mention,
      keywords: partial.triggers?.keywords ?? [...global.defaultTriggers.keywords],
      randomChance: partial.triggers?.randomChance ?? global.defaultTriggers.randomChance,
      keywordDebounceMs: partial.triggers?.keywordDebounceMs ?? global.defaultTriggers.keywordDebounceMs,
      typingIdleMs: partial.triggers?.typingIdleMs ?? global.defaultTriggers.typingIdleMs,
      typingMaxWaitMs: partial.triggers?.typingMaxWaitMs ?? global.defaultTriggers.typingMaxWaitMs,
    },
    triggerInstructions: {
      mention: partial.triggerInstructions?.mention ?? global.defaultTriggerInstructions.mention,
      keyword: partial.triggerInstructions?.keyword ?? global.defaultTriggerInstructions.keyword,
      random: partial.triggerInstructions?.random ?? global.defaultTriggerInstructions.random,
      scheduled: partial.triggerInstructions?.scheduled ?? global.defaultTriggerInstructions.scheduled,
    },
    llmProvider: parseLlmProvider(partial.llmProvider, "llmProvider") ?? global.defaultLlmProvider,
    model: partial.model,
    modelParams: { ...global.defaultModelParams, ...partial.modelParams },
    thinkingLevel: parseThinkingLevel(partial.thinkingLevel, "thinkingLevel") ?? global.defaultThinkingLevel,
    timezone: partial.timezone ?? global.defaultTimezone,
    trim: {
      trimTrigger: partial.trim?.trimTrigger ?? global.defaultTrim.trimTrigger,
      trimTarget: partial.trim?.trimTarget ?? global.defaultTrim.trimTarget,
      windowSize: partial.trim?.windowSize ?? global.defaultTrim.windowSize,
      messageCharLimit: partial.trim?.messageCharLimit ?? global.defaultTrim.messageCharLimit,
      replyQuoteChars: partial.trim?.replyQuoteChars ?? global.defaultTrim.replyQuoteChars,
    },
    adminUserIds: partial.adminUserIds ?? [],
    imageMaxDimension: partial.imageMaxDimension ?? global.defaultImageMaxDimension,
    mergeMessageGapSeconds: partial.mergeMessageGapSeconds ?? global.defaultMergeMessageGapSeconds,
    imageReadMaxPerCall: partial.imageReadMaxPerCall ?? global.defaultImageReadMaxPerCall,
    imageCaptioningEnabled: partial.imageCaptioningEnabled ?? global.defaultImageCaptioningEnabled,
    imageReading: resolveGuildImageReading(global.defaultImageReading, partial.imageReading),
    imageGeneration: resolveGuildImageGeneration(global.defaultImageGeneration, partial.imageGeneration),
    attachmentsDir: partial.attachmentsDir ?? global.defaultAttachmentsDir,
    instructions: instructions !== "" ? instructions : global.defaultInstructions,
    tts: resolveTtsConfig(partial.tts) ?? global.defaultTts,
    emotes: {
      include: partial.emotes?.include ?? global.defaultEmotes.include,
    },
    members: {
      include: partial.members?.include ?? global.defaultMembers.include,
    },
    dispatcher: {
      enabled: partial.dispatcher?.enabled ?? global.defaultDispatcher.enabled,
      mentionDebounceMs: partial.dispatcher?.mentionDebounceMs ?? global.defaultDispatcher.mentionDebounceMs,
      defaultDebounceMs: partial.dispatcher?.defaultDebounceMs ?? global.defaultDispatcher.defaultDebounceMs,
    },
    agentJobs: resolveGuildAgentJobs(global.defaultAgentJobs, partial.agentJobs),
    promptCaching,
    promptTransport: resolveGuildPromptTransport(global.defaultPromptTransport, partial.promptTransport),
    backgroundLlm: resolveGuildBackgroundLlm(global, partial, promptCaching),
    replyLoop: resolveGuildReplyLoop(global.defaultReplyLoop, partial.replyLoop),
    memoryExtraction: resolveGuildMemoryExtraction(global.defaultMemoryExtraction, partial.memoryExtraction),
  };
}

/** Validate trim config invariants. Throws on violation. */
export function validateTrimConfig(trim: TrimConfig): void {
  if (trim.windowSize < 1) {
    throw new Error("trim.windowSize must be at least 1");
  }
  if (trim.trimTarget < trim.windowSize) {
    throw new Error("trim.trimTarget must be >= trim.windowSize");
  }
  if (trim.trimTrigger <= trim.trimTarget) {
    throw new Error("trim.trimTrigger must be > trim.trimTarget");
  }
}

function validateGuildLlmCredentials(global: GlobalConfig, guild: GuildConfig): void {
  const usesOpenRouter = guild.llmProvider === "openrouter"
    || guild.backgroundLlm.provider === "openrouter"
    || (guild.imageReading.fallbackEnabled && guild.imageReading.fallbackProvider === "openrouter");
  if (!usesOpenRouter) return;
  if (global.openrouterApiKey === undefined || global.openrouterApiKey === "") {
    throw new Error(`OPENROUTER_API_KEY is required by guild ${guild.guildId} OpenRouter LLM configuration`);
  }
}

/** Load all guild configs from a directory, resolved against global defaults. */
export function loadGuildConfigs(
  guildsDir: string,
  global: GlobalConfig
): Map<string, GuildConfig> {
  const result = new Map<string, GuildConfig>();
  if (!existsSync(guildsDir)) return result;

  const files = readdirSync(guildsDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  for (const file of files) {
    const partial = loadGuildConfigFile(join(guildsDir, file));
    const resolved = resolveGuildConfig(global, partial);
    validateGuildLlmCredentials(global, resolved);
    result.set(partial.guildId, resolved);
  }
  return result;
}

/** Check if a TriggerInstructions object has any non-empty values. */
function hasTriggerInstructions(ti: TriggerInstructions): boolean {
  return (ti.mention !== undefined && ti.mention !== "") ||
    (ti.keyword !== undefined && ti.keyword !== "") ||
    (ti.random !== undefined && ti.random !== "") ||
    (ti.scheduled !== undefined && ti.scheduled !== "");
}

/** Persist a resolved guild config back to its YAML file (source of truth). */
export function saveGuildConfig(filePath: string, config: GuildConfig): void {
  // Write only the per-guild fields (not guildId/slug — those are in the filename)
  const yaml: GuildConfigYaml = {
    triggers: config.triggers,
    triggerInstructions: hasTriggerInstructions(config.triggerInstructions) ? config.triggerInstructions : undefined,
    llmProvider: config.llmProvider,
    model: config.model,
    modelParams: config.modelParams,
    thinkingLevel: config.thinkingLevel,
    timezone: config.timezone,
    trim: config.trim,
    adminUserIds: config.adminUserIds.length > 0 ? config.adminUserIds : undefined,
    imageMaxDimension: config.imageMaxDimension,
    mergeMessageGapSeconds: config.mergeMessageGapSeconds,
    imageReadMaxPerCall: config.imageReadMaxPerCall,
    imageCaptioningEnabled: config.imageCaptioningEnabled,
    imageReading: config.imageReading,
    imageGeneration: config.imageGeneration,
    attachmentsDir: config.attachmentsDir,
    instructions: config.instructions !== "" ? config.instructions : undefined,
    tts: config.tts,
    emotes: config.emotes,
    members: config.members,
    dispatcher: config.dispatcher,
    promptCaching: config.promptCaching,
    promptTransport: config.promptTransport,
    backgroundLlm: config.backgroundLlm,
    replyLoop: config.replyLoop,
    memoryExtraction: config.memoryExtraction,
  };

  // Strip undefined keys before serializing
  const clean = JSON.parse(JSON.stringify(yaml)) as GuildConfigYaml;
  writeFileSync(filePath, stringify(clean));
}
