import { parse, stringify } from "yaml";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "fs";
import { join, basename } from "path";
import type {
  GlobalConfig,
  GuildConfig,
  GuildConfigYaml,
  MainConfigYaml,
  TriggerConfig,
  TrimConfig,
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
    defaultThinkingLevel: yaml.thinkingLevel ?? "medium",
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
    defaultMemoryRetentionDays: yaml.memoryRetentionDays ?? 180,
    defaultImageMaxDimension: yaml.imageMaxDimension ?? 768,
    defaultMergeMessageGapSeconds: yaml.mergeMessageGapSeconds ?? 120,
    defaultImageReadMaxPerCall: yaml.imageReadMaxPerCall ?? 10,
    defaultImageCaptioningEnabled: yaml.imageCaptioningEnabled ?? false,
    defaultAttachmentsDir,
    defaultInstructions,
    personaPath: yaml.personaPath ?? "config/persona.md",
    logLevel: yaml.logLevel ?? "info",
    dataDir,
    modelCacheDir: yaml.modelCacheDir ?? "model-cache",
    qdrantUrl: env.QDRANT_URL ?? yaml.qdrantUrl ?? "http://localhost:6333",
    elevenLabsApiKey: env.ELEVENLABS_API_KEY,
    defaultTts: resolveTtsConfig(yaml.tts),
    vpnApiUrl: env.VPN_API_URL ?? yaml.vpnApiUrl ?? "https://2b.lmao13.co",
    vpnPeer: env.VPN_PEER ?? env.PEER ?? yaml.vpnPeer ?? "195.2.71.75",
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
    model: partial.model,
    modelParams: partial.modelParams,
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

/** Persist a resolved guild config back to its YAML file (source of truth). */
export function saveGuildConfig(filePath: string, config: GuildConfig): void {
  // Write only the per-guild fields (not guildId/slug — those are in the filename)
  const yaml: GuildConfigYaml = {
    triggers: config.triggers,
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
  };

  // Strip undefined keys before serializing
  const clean = JSON.parse(JSON.stringify(yaml)) as GuildConfigYaml;
  writeFileSync(filePath, stringify(clean));
}
