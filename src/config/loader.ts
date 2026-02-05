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
  UiLang,
  VpnConfig,
  BashToolConfig,
  EmotesConfig,
} from "./types.ts";
import type { TtsConfig, VoicePreset } from "../tts/types.ts";

const DEFAULT_TRIGGER: TriggerConfig = {
  mention: true,
  keywords: [],
  randomChance: 0,
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
  model: "eleven_flash_v2_5",
};

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

  const whisperVoice = resolveVoicePreset(partial.voices?.whisper);

  return {
    enabled: true,
    voices: {
      normal: normalVoice,
      ...(whisperVoice !== undefined ? { whisper: whisperVoice } : {}),
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

const DEFAULT_BASH_TIMEOUT_MS = 5000;
const DEFAULT_BASH_OUTPUT_LIMIT = 4000;

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

  const openrouterApiKey = env.OPENROUTER_API_KEY;
  if (openrouterApiKey === undefined || openrouterApiKey === "") throw new Error("OPENROUTER_API_KEY is required");

  const yaml = loadMainConfig(configPath);

  const dataDir = yaml.dataDir ?? "data";
  const defaultAttachmentsDir = yaml.attachmentsDir ?? `${dataDir}/attachments`;

  const defaultInstructions = resolveInstructions(yaml.instructions, yaml.instructionsPath);

  return {
    discordToken,
    openrouterApiKey,
    braveApiKey: env.BRAVE_API_KEY,
    defaultModel: yaml.model ?? "moonshotai/kimi-k2.5",
    defaultModelParams: yaml.modelParams ?? {},
    defaultThinkingLevel: yaml.thinkingLevel,
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
    },
    defaultTriggerInstructions: {
      mention: yaml.triggerInstructions?.mention,
      keyword: yaml.triggerInstructions?.keyword,
      random: yaml.triggerInstructions?.random,
      scheduled: yaml.triggerInstructions?.scheduled,
    },
    defaultMemoryRetentionDays: yaml.memoryRetentionDays ?? 180,
    defaultImageMaxDimension: yaml.imageMaxDimension ?? 768,
    defaultMergeMessageGapSeconds: yaml.mergeMessageGapSeconds ?? 120,
    defaultImageReadMaxPerCall: yaml.imageReadMaxPerCall ?? 10,
    defaultImageCaptioningEnabled: yaml.imageCaptioningEnabled ?? false,
    defaultAttachmentsDir,
    defaultInstructions,
    personaPath: yaml.personaPath ?? "config/persona.md",
    toolInstructionsPath: yaml.toolInstructionsPath ?? "config/tool_instructions.md",
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
    defaultForceToolCallFirstRun: yaml.forceToolCallFirstRun ?? false,
    defaultDisableParallelToolCallsFirstRun: yaml.disableParallelToolCallsFirstRun ?? false,
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
  const { guildId, slug } = parseGuildFilename(basename(filePath));
  return { guildId, slug, ...parsed };
}

/** Merge a guild partial onto global defaults to produce a fully resolved GuildConfig. */
export function resolveGuildConfig(
  global: GlobalConfig,
  partial: GuildConfigYaml & { guildId: string; slug: string }
): GuildConfig {
  const instructions = resolveInstructions(partial.instructions, partial.instructionsPath);

  return {
    guildId: partial.guildId,
    slug: partial.slug,
    triggers: {
      mention: partial.triggers?.mention ?? global.defaultTriggers.mention,
      keywords: partial.triggers?.keywords ?? [...global.defaultTriggers.keywords],
      randomChance: partial.triggers?.randomChance ?? global.defaultTriggers.randomChance,
    },
    triggerInstructions: {
      mention: partial.triggerInstructions?.mention ?? global.defaultTriggerInstructions.mention,
      keyword: partial.triggerInstructions?.keyword ?? global.defaultTriggerInstructions.keyword,
      random: partial.triggerInstructions?.random ?? global.defaultTriggerInstructions.random,
      scheduled: partial.triggerInstructions?.scheduled ?? global.defaultTriggerInstructions.scheduled,
    },
    model: partial.model,
    modelParams: { ...global.defaultModelParams, ...partial.modelParams },
    thinkingLevel: partial.thinkingLevel ?? global.defaultThinkingLevel,
    timezone: partial.timezone ?? global.defaultTimezone,
    trim: {
      trimTrigger: partial.trim?.trimTrigger ?? global.defaultTrim.trimTrigger,
      trimTarget: partial.trim?.trimTarget ?? global.defaultTrim.trimTarget,
      windowSize: partial.trim?.windowSize ?? global.defaultTrim.windowSize,
      messageCharLimit: partial.trim?.messageCharLimit ?? global.defaultTrim.messageCharLimit,
      replyQuoteChars: partial.trim?.replyQuoteChars ?? global.defaultTrim.replyQuoteChars,
    },
    memoryRetentionDays: partial.memoryRetentionDays ?? global.defaultMemoryRetentionDays,
    adminUserIds: partial.adminUserIds ?? [],
    imageMaxDimension: partial.imageMaxDimension ?? global.defaultImageMaxDimension,
    mergeMessageGapSeconds: partial.mergeMessageGapSeconds ?? global.defaultMergeMessageGapSeconds,
    imageReadMaxPerCall: partial.imageReadMaxPerCall ?? global.defaultImageReadMaxPerCall,
    imageCaptioningEnabled: partial.imageCaptioningEnabled ?? global.defaultImageCaptioningEnabled,
    attachmentsDir: partial.attachmentsDir ?? global.defaultAttachmentsDir,
    instructions: instructions !== "" ? instructions : global.defaultInstructions,
    tts: resolveTtsConfig(partial.tts) ?? global.defaultTts,
    bashTool: resolveGuildBashToolConfig(global.defaultBashTool, partial.bashTool),
    emotes: {
      include: partial.emotes?.include ?? global.defaultEmotes.include,
    },
    forceToolCallFirstRun: partial.forceToolCallFirstRun ?? global.defaultForceToolCallFirstRun,
    disableParallelToolCallsFirstRun: partial.disableParallelToolCallsFirstRun ?? global.defaultDisableParallelToolCallsFirstRun,
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
    result.set(partial.guildId, resolveGuildConfig(global, partial));
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
    model: config.model,
    modelParams: config.modelParams,
    thinkingLevel: config.thinkingLevel,
    timezone: config.timezone,
    trim: config.trim,
    memoryRetentionDays: config.memoryRetentionDays,
    adminUserIds: config.adminUserIds.length > 0 ? config.adminUserIds : undefined,
    imageMaxDimension: config.imageMaxDimension,
    mergeMessageGapSeconds: config.mergeMessageGapSeconds,
    imageReadMaxPerCall: config.imageReadMaxPerCall,
    imageCaptioningEnabled: config.imageCaptioningEnabled,
    attachmentsDir: config.attachmentsDir,
    instructions: config.instructions !== "" ? config.instructions : undefined,
    tts: config.tts,
    bashTool: config.bashTool !== undefined ? { enabled: config.bashTool.enabled } : undefined,
    emotes: config.emotes,
  };

  // Strip undefined keys before serializing
  const clean = JSON.parse(JSON.stringify(yaml)) as GuildConfigYaml;
  writeFileSync(filePath, stringify(clean));
}
