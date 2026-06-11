import { parse, stringify } from "yaml";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "fs";
import { join, basename, dirname } from "path";
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
  BashToolConfig,
  EmotesConfig,
  MembersConfig,
  DispatcherConfig,
  PromptCachingConfig,
  BackgroundLlmConfig,
  BackgroundLlmDefaults,
  ImageReadingConfig,
  ReplyLoopConfig,
  PromptProfileConfig,
  PromptSource,
  ServiceTier,
  LlmProvider,
} from "./types.ts";
import type { TextNormalizationMode, TtsConfig, VoicePreset } from "../tts/types.ts";
import type { Logger, TokenUsage } from "../logger.ts";
import { loadPromptSourceChain } from "./prompt-profile.ts";

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

/**
 * Default blocklist patterns for the bash tool.
 * Blocks: shutdown/reboot, network/firewall admin, iptables, container escape attempts,
 * fork bombs, and resource exhaustion patterns.
 */
const DEFAULT_BASH_BLOCKLIST: string[] = [
  // System shutdown/reboot
  "\\b(shutdown|reboot|poweroff|halt|init\\s+[06])\\b",
  // Network/firewall administration
  "\\b(iptables|ip6tables|nft|nftables|ufw|firewall-cmd|firewalld)\\b",
  // Network interface and socket tools
  "\\b(ifconfig|ip\\s+(link|addr|route)|route\\s+(add|del)|ss|netstat)\\b",
  // System control
  "\\b(sysctl|systemctl|service)\\b",
  // Container/VM escape attempts
  "\\b(docker|podman|kubectl|nsenter|chroot)\\b",
  // Kernel module manipulation
  "\\b(modprobe|insmod|rmmod|lsmod)\\b",
  // Disk/mount operations
  "\\b(mount|umount|mkfs|fdisk|parted)\\b",
  // SSH daemon attacks
  "\\b(killall\\s+sshd|pkill\\s+sshd)\\b",
  // Fork bombs and recursive process spawning
  ":\\(\\)\\s*\\{.*\\|.*&.*\\}",  // Classic fork bomb :(){ :|:& };:
  "\\|\\s*:\\s*&",                // Piping to : with background
  "\\bwhile\\b.*\\bdone\\s*&",    // Backgrounded while loops
];

const DEFAULT_BASH_SSH = {
  host: "bash-vm",
  port: 22,
  user: "user",
};

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

const DEFAULT_REPLY_LOOP: ReplyLoopConfig = {
  maxToolCalls: 16,
  wallClockTimeoutMs: 45_000,
  llmOutputTimeoutMs: 12_000,
};

type PromptSourceYaml =
  NonNullable<NonNullable<MainConfigYaml["promptProfile"]>["persona"]>[number];

const SILENT_PROMPT_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  logTokenUsage: (_usage: TokenUsage) => {},
  child: () => SILENT_PROMPT_LOGGER,
};

function defaultPromptProfile(
  configPath: string,
): PromptProfileConfig {
  const promptDir = join(dirname(configPath), "..", "prompts");
  return {
    persona: [{ kind: "file", path: join(promptDir, "persona.md"), optional: false }],
    toolInstructions: [],
    instructions: [],
    lateInstructions: [{ kind: "file", path: join(promptDir, "style.md"), optional: false }],
  };
}

function resolvePromptSource(
  source: PromptSourceYaml,
  section: "persona" | "toolInstructions" | "instructions" | "lateInstructions",
  index: number,
): PromptSource {
  const filePath = source.file;
  const hasFile = typeof filePath === "string" && filePath !== "";
  const hasText = typeof source.text === "string";
  if (hasFile === hasText) {
    throw new Error(`promptProfile.${section}[${index}] must define exactly one of "file" or "text"`);
  }
  if (hasFile) {
    return {
      kind: "file",
      path: filePath,
      optional: source.optional === true,
    };
  }
  return {
    kind: "inline",
    text: source.text ?? "",
  };
}

function resolvePromptSources(
  sources: PromptSourceYaml[] | undefined,
  fallback: PromptSource[],
  section: "persona" | "toolInstructions" | "instructions" | "lateInstructions",
): PromptSource[] {
  if (sources === undefined) return fallback;
  return sources.map((source, idx) => resolvePromptSource(source, section, idx));
}

function resolvePromptProfile(
  partial: MainConfigYaml["promptProfile"] | undefined,
  configPath: string,
): PromptProfileConfig {
  const fallback = defaultPromptProfile(configPath);
  if (partial === undefined) return fallback;
  return {
    persona: resolvePromptSources(partial.persona, fallback.persona, "persona"),
    toolInstructions: resolvePromptSources(partial.toolInstructions, fallback.toolInstructions, "toolInstructions"),
    instructions: resolvePromptSources(partial.instructions, fallback.instructions, "instructions"),
    lateInstructions: resolvePromptSources(partial.lateInstructions, fallback.lateInstructions, "lateInstructions"),
  };
}

const DEFAULT_BASH_TIMEOUT_MS = 5000;
const DEFAULT_BASH_OUTPUT_LIMIT = 4000;

function resolveGlobalPromptCaching(
  partial: MainConfigYaml["promptCaching"] | undefined
): PromptCachingConfig {
  return {
    enabled: partial?.enabled ?? DEFAULT_PROMPT_CACHING.enabled,
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

/**
 * Resolve bash tool config from YAML partial.
 * Returns undefined if bash tool is not enabled.
 */
function resolveBashToolConfig(
  partial: MainConfigYaml["bashTool"] | undefined
): BashToolConfig | undefined {
  if (partial?.enabled !== true) return undefined;
  return {
    enabled: true,
    ssh: {
      host: partial.ssh?.host ?? DEFAULT_BASH_SSH.host,
      port: partial.ssh?.port ?? DEFAULT_BASH_SSH.port,
      user: partial.ssh?.user ?? DEFAULT_BASH_SSH.user,
    },
    timeoutMs: partial.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS,
    outputLimit: partial.outputLimit ?? DEFAULT_BASH_OUTPUT_LIMIT,
    blocklist: partial.blocklist ?? [...DEFAULT_BASH_BLOCKLIST],
  };
}

/**
 * Validate bash tool config. Throws if enabled but missing required fields.
 */
export function validateBashToolConfig(bashTool: BashToolConfig | undefined): void {
  if (bashTool === undefined || !bashTool.enabled) return;
  if (bashTool.ssh.host === "") throw new Error("bashTool.ssh.host required when bashTool.enabled");
  if (bashTool.ssh.port <= 0 || bashTool.ssh.port > 65535) {
    throw new Error("bashTool.ssh.port must be 1-65535");
  }
  if (bashTool.ssh.user === "") throw new Error("bashTool.ssh.user required when bashTool.enabled");
  if (bashTool.timeoutMs <= 0) throw new Error("bashTool.timeoutMs must be positive");
  if (bashTool.outputLimit <= 0) throw new Error("bashTool.outputLimit must be positive");
  // Validate blocklist patterns are valid regex
  for (const pattern of bashTool.blocklist) {
    try {
      new RegExp(pattern, "i");
    } catch {
      throw new Error(`bashTool.blocklist contains invalid regex: ${pattern}`);
    }
  }
}

/**
 * Resolve guild-level bash tool config.
 * Guild can only toggle enabled; all other settings come from global.
 * Returns undefined if global is disabled or guild disables it.
 */
function resolveGuildBashToolConfig(
  global: BashToolConfig | undefined,
  guildPartial: GuildConfigYaml["bashTool"] | undefined
): BashToolConfig | undefined {
  // If global is disabled, guild cannot enable
  if (global === undefined || !global.enabled) return undefined;
  // Guild can explicitly disable
  if (guildPartial?.enabled === false) return undefined;
  // Otherwise inherit global config (guild enabled by default when global is enabled)
  return global;
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
      throw new Error(`Deprecated config key "${key}" is no longer supported. Use promptProfile instead.`);
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
  const openrouterApiKey = env.OPENROUTER_API_KEY;
  const usesOpenRouter = defaultLlmProvider === "openrouter"
    || yaml.backgroundLlm?.provider === "openrouter"
    || (defaultImageReading.fallbackEnabled && defaultImageReading.fallbackProvider === "openrouter");
  if (usesOpenRouter && (openrouterApiKey === undefined || openrouterApiKey === "")) {
    throw new Error("OPENROUTER_API_KEY is required when any OpenRouter LLM backend is enabled");
  }

  const defaultAttachmentsDir = yaml.attachmentsDir ?? `${dataDir}/attachments`;
  const promptProfile = resolvePromptProfile(yaml.promptProfile, configPath);

  const defaultInstructions = loadPromptSourceChain(
    promptProfile.instructions,
    "instructions",
    SILENT_PROMPT_LOGGER,
  );
  const defaultLateInstruction = loadPromptSourceChain(
    promptProfile.lateInstructions,
    "lateInstructions",
    SILENT_PROMPT_LOGGER,
  );

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
    defaultImageMaxDimension: yaml.imageMaxDimension ?? 768,
    defaultMergeMessageGapSeconds: yaml.mergeMessageGapSeconds ?? 120,
    defaultImageReadMaxPerCall: yaml.imageReadMaxPerCall ?? 10,
    defaultImageCaptioningEnabled: yaml.imageCaptioningEnabled ?? false,
    defaultImageReading,
    defaultAttachmentsDir,
    defaultInstructions,
    defaultLateInstruction,
    promptProfile,
    logLevel: yaml.logLevel ?? "info",
    dataDir,
    modelCacheDir: yaml.modelCacheDir ?? "model-cache",
    qdrantUrl: env.QDRANT_URL ?? yaml.qdrantUrl ?? "http://localhost:6333",
    elevenLabsApiKey: env.ELEVENLABS_API_KEY,
    defaultTts: resolveTtsConfig(yaml.tts),
    uiLang: (yaml.uiLang === "ru" ? "ru" : "en") as UiLang,
    vpn: resolveVpnConfig(yaml.vpn),
    defaultBashTool: resolveBashToolConfig(yaml.bashTool),
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
    defaultPromptCaching: resolveGlobalPromptCaching(yaml.promptCaching),
    defaultBackgroundLlm: resolveGlobalBackgroundLlm(yaml.backgroundLlm),
    defaultReplyLoop: resolveGlobalReplyLoop(yaml.replyLoop),
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
    attachmentsDir: partial.attachmentsDir ?? global.defaultAttachmentsDir,
    instructions: instructions !== "" ? instructions : global.defaultInstructions,
    tts: resolveTtsConfig(partial.tts) ?? global.defaultTts,
    bashTool: resolveGuildBashToolConfig(global.defaultBashTool, partial.bashTool),
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
    promptCaching,
    backgroundLlm: resolveGuildBackgroundLlm(global, partial, promptCaching),
    replyLoop: resolveGuildReplyLoop(global.defaultReplyLoop, partial.replyLoop),
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
    attachmentsDir: config.attachmentsDir,
    instructions: config.instructions !== "" ? config.instructions : undefined,
    tts: config.tts,
    bashTool: config.bashTool !== undefined ? { enabled: config.bashTool.enabled } : undefined,
    emotes: config.emotes,
    members: config.members,
    dispatcher: config.dispatcher,
    promptCaching: config.promptCaching,
    backgroundLlm: config.backgroundLlm,
    replyLoop: config.replyLoop,
  };

  // Strip undefined keys before serializing
  const clean = JSON.parse(JSON.stringify(yaml)) as GuildConfigYaml;
  writeFileSync(filePath, stringify(clean));
}
