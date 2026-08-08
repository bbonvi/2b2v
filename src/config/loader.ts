import { parse, stringify } from "yaml";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import {
  DEFAULT_DISPATCHER,
  DEFAULT_EMOTES,
  DEFAULT_MEMBERS,
  DEFAULT_SCHEDULE_PRESSURE,
  DEFAULT_TRIGGER,
  DEFAULT_CONTEXT_HISTORY,
  DEFAULT_TYPING_SIMULATION,
} from "./defaults.ts";
import type {
  GlobalConfig,
  GuildConfig,
  GuildConfigYaml,
  MainConfigYaml,
  ContextHistoryConfig,
  VpnConfig,
} from "./types.ts";
import { resolvePersonaModesConfig } from "../modes/config.ts";
import { stripMarkdownComments } from "./instruction-text.ts";
import {
  resolveAmbientAttentionConfig,
  resolveAmbientInitiativeConfig,
  resolvePrivateLifeConfig,
} from "./autonomy-config.ts";
import {
  resolveGlobalPromptTransport,
  resolveGuildPromptTransport,
  requireModelProfile,
  resolveModelProfiles,
  validateModelProfileReferences,
} from "./model-config.ts";
import {
  resolveAssetReadingConfig,
  resolveExternalImagesConfig,
  resolveGlobalImageGeneration,
  resolveGlobalImageReading,
  resolveGuildImageGeneration,
  resolveGuildImageReading,
  resolveImageReferenceMaxPerCall,
} from "./media-config.ts";
import {
  DEFAULT_VOICE_CONFIG,
  resolveTtsConfig,
  resolveVoiceConfig,
} from "./voice-config.ts";
import {
  resolveAgentJobs,
  resolveGlobalMemoryExtraction,
  resolveGlobalReplyLoop,
  resolveGuildMemoryExtraction,
  resolveGuildReplyLoop,
  resolveInnerThreadsConfig,
  resolveMemoryContext,
  resolveNotebooksConfig,
  resolveRelationshipConfig,
  resolveRepertoireConfig,
  resolveSchedulePressure,
  resolveTypingSimulationConfig,
} from "./agent-config.ts";

/**
 * Resolve VPN config from YAML partial.
 * Returns undefined if VPN is not enabled.
 */
function resolveVpnConfig(
  partial: MainConfigYaml["vpn"] | undefined,
  env: Record<string, string | undefined>,
): VpnConfig | undefined {
  if (partial?.enabled !== true) return undefined;
  const apiUrl = env.VPN_API_URL?.trim();
  const vpnPeer = env.VPN_PEER?.trim();
  return {
    enabled: true,
    apiUrl: apiUrl !== undefined && apiUrl !== "" ? apiUrl : partial.apiUrl ?? "",
    vpnPeer: vpnPeer !== undefined && vpnPeer !== "" ? vpnPeer : partial.vpnPeer ?? "",
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
 * Load and parse the main config YAML file.
 * Returns an empty object if the file does not exist.
 * Throws on malformed YAML.
 */
export function loadMainConfig(configPath: string): MainConfigYaml {
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
  return stripMarkdownComments(readFileSync(filePath, "utf-8")).trim();
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
  env: Record<string, string | undefined>,
  configPath: string,
): GlobalConfig {
  const discordToken = env.DISCORD_TOKEN;
  if (discordToken === undefined || discordToken === "") throw new Error("DISCORD_TOKEN is required");

  const yaml = loadMainConfig(configPath);
  const configuredRuntimeProfileId = env.PROFILE?.trim();
  const runtimeProfileId = configuredRuntimeProfileId !== undefined && configuredRuntimeProfileId !== ""
    ? configuredRuntimeProfileId
    : basename(dirname(configPath));
  assertNoDeprecatedReplyLoopKey(yaml, "global");
  const dataDir = yaml.dataDir ?? "data";
  const modelProfiles = resolveModelProfiles(yaml.modelProfiles);
  const defaultModelProfile = requireModelProfile(
    modelProfiles,
    yaml.modelProfile ?? "main",
    "modelProfile",
  );
  const defaultImageReading = resolveGlobalImageReading(yaml.imageReading);
  const defaultImageGeneration = resolveGlobalImageGeneration(yaml.imageGeneration);
  const defaultAmbientAttention = resolveAmbientAttentionConfig(undefined, yaml.ambientAttention);
  const defaultAmbientInitiative = resolveAmbientInitiativeConfig(undefined, yaml.ambientInitiative);
  const privateLife = resolvePrivateLifeConfig(yaml.privateLife);
  const defaultMemoryExtraction = resolveGlobalMemoryExtraction(yaml.memoryExtraction);
  const defaultMemoryContext = resolveMemoryContext(undefined, yaml.memoryContext);
  const repertoire = resolveRepertoireConfig(yaml.repertoire);
  const defaultRelationships = resolveRelationshipConfig(undefined, yaml.relationships);
  const defaultInnerThreads = resolveInnerThreadsConfig(undefined, yaml.innerThreads);
  const defaultNotebooks = resolveNotebooksConfig(undefined, yaml.notebooks);
  const defaultVoice = resolveVoiceConfig(DEFAULT_VOICE_CONFIG, yaml.voice);
  const personaModes = resolvePersonaModesConfig(yaml.personaModes, dirname(configPath));
  validateModelProfileReferences(modelProfiles, [
    [defaultModelProfile, "modelProfile"],
    [defaultImageReading.fallbackModelProfile, "imageReading.fallbackModelProfile"],
    [defaultImageGeneration.modelProfile, "imageGeneration.modelProfile"],
    [defaultMemoryExtraction.modelProfile, "memoryExtraction.modelProfile"],
    [defaultRelationships.modelProfile, "relationships.modelProfile"],
    [defaultInnerThreads.modelProfile, "innerThreads.modelProfile"],
    [defaultVoice.modelProfile, "voice.modelProfile"],
    [defaultVoice.maintenance.summary.modelProfile, "voice.maintenance.summary.modelProfile"],
    [defaultVoice.maintenance.extraction.modelProfile, "voice.maintenance.extraction.modelProfile"],
    ...(defaultAmbientAttention !== undefined
      ? [[defaultAmbientAttention.evaluator.modelProfile, "ambientAttention.evaluator.modelProfile"] as const]
      : []),
    ...(defaultAmbientInitiative !== undefined
      ? [[defaultAmbientInitiative.evaluator.modelProfile, "ambientInitiative.evaluator.modelProfile"] as const]
      : []),
    [privateLife.modelProfile, "privateLife.modelProfile"],
    [privateLife.maintenance.modelProfile, "privateLife.maintenance.modelProfile"],
  ]);
  const openrouterApiKey = env.OPENROUTER_API_KEY;
  const usesOpenRouter = Object.values(modelProfiles).some((profile) => profile.provider === "openrouter");
  if (usesOpenRouter && (openrouterApiKey === undefined || openrouterApiKey === "")) {
    throw new Error("OPENROUTER_API_KEY is required when any OpenRouter LLM backend is enabled");
  }

  return {
    runtimeProfileId,
    discordToken,
    ...(openrouterApiKey !== undefined && openrouterApiKey !== "" ? { openrouterApiKey } : {}),
    codexAuthPath: env.CODEX_AUTH_PATH ?? `${dataDir}/codex-auth.json`,
    braveApiKey: env.BRAVE_API_KEY,
    externalImages: resolveExternalImagesConfig(yaml.externalImages),
    modelProfiles,
    defaultModelProfile,
    defaultTimezone: yaml.timezone ?? "UTC",
    defaultContextHistory: {
      retainedMessages: yaml.contextHistory?.retainedMessages ?? DEFAULT_CONTEXT_HISTORY.retainedMessages,
      recentMessages: yaml.contextHistory?.recentMessages ?? DEFAULT_CONTEXT_HISTORY.recentMessages,
      messageCharLimit: yaml.contextHistory?.messageCharLimit ?? DEFAULT_CONTEXT_HISTORY.messageCharLimit,
    },
    defaultTriggers: {
      mention: yaml.triggers?.mention ?? DEFAULT_TRIGGER.mention,
      keywords: yaml.triggers?.keywords ?? [...DEFAULT_TRIGGER.keywords],
      randomChance: yaml.triggers?.randomChance ?? DEFAULT_TRIGGER.randomChance,
      keywordDebounceMs: yaml.triggers?.keywordDebounceMs ?? DEFAULT_TRIGGER.keywordDebounceMs,
      typingIdleMs: yaml.triggers?.typingIdleMs ?? DEFAULT_TRIGGER.typingIdleMs,
      typingResumeGraceMs: yaml.triggers?.typingResumeGraceMs ?? DEFAULT_TRIGGER.typingResumeGraceMs,
      typingMaxWaitMs: yaml.triggers?.typingMaxWaitMs ?? DEFAULT_TRIGGER.typingMaxWaitMs,
    },
    defaultMergeMessageGapSeconds: yaml.mergeMessageGapSeconds ?? 120,
    defaultImageReferenceMaxPerCall: resolveImageReferenceMaxPerCall(yaml.imageReferenceMaxPerCall, 10, "imageReferenceMaxPerCall"),
    defaultImageReading,
    defaultImageGeneration,
    defaultAssetReading: resolveAssetReadingConfig(yaml.assetReading),
    logLevel: yaml.logLevel ?? "info",
    dataDir,
    elevenLabsApiKey: env.ELEVENLABS_API_KEY,
    defaultTts: resolveTtsConfig(yaml.tts),
    uiLang: yaml.uiLang === "ru" ? "ru" : "en",
    vpn: resolveVpnConfig(yaml.vpn, env),
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
    defaultTypingSimulation: resolveTypingSimulationConfig(DEFAULT_TYPING_SIMULATION, yaml.typingSimulation),
    agentJobs: resolveAgentJobs(yaml.agentJobs),
    defaultSchedulePressure: resolveSchedulePressure(DEFAULT_SCHEDULE_PRESSURE, yaml.schedulePressure, "schedulePressure"),
    defaultPromptTransport: resolveGlobalPromptTransport(yaml.promptTransport),
    defaultAmbientAttention,
    defaultAmbientInitiative,
    privateLife,
    defaultReplyLoop: resolveGlobalReplyLoop(yaml.replyLoop),
    defaultMemoryExtraction,
    defaultMemoryContext,
    repertoire,
    defaultRelationships,
    defaultInnerThreads,
    defaultNotebooks,
    defaultVoice,
    personaModes,
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
  const config: GuildConfig = {
    guildId: partial.guildId,
    slug: partial.slug,
    triggers: {
      mention: partial.triggers?.mention ?? global.defaultTriggers.mention,
      keywords: partial.triggers?.keywords ?? [...global.defaultTriggers.keywords],
      randomChance: partial.triggers?.randomChance ?? global.defaultTriggers.randomChance,
      keywordDebounceMs: partial.triggers?.keywordDebounceMs ?? global.defaultTriggers.keywordDebounceMs,
      typingIdleMs: partial.triggers?.typingIdleMs ?? global.defaultTriggers.typingIdleMs,
      typingResumeGraceMs: partial.triggers?.typingResumeGraceMs ?? global.defaultTriggers.typingResumeGraceMs,
      typingMaxWaitMs: partial.triggers?.typingMaxWaitMs ?? global.defaultTriggers.typingMaxWaitMs,
    },
    modelProfile: requireModelProfile(
      global.modelProfiles,
      partial.modelProfile ?? global.defaultModelProfile,
      "modelProfile",
    ),
    timezone: partial.timezone ?? global.defaultTimezone,
    contextHistory: {
      retainedMessages: partial.contextHistory?.retainedMessages ?? global.defaultContextHistory.retainedMessages,
      recentMessages: partial.contextHistory?.recentMessages ?? global.defaultContextHistory.recentMessages,
      messageCharLimit: partial.contextHistory?.messageCharLimit ?? global.defaultContextHistory.messageCharLimit,
    },
    adminUserIds: partial.adminUserIds ?? [],
    mergeMessageGapSeconds: partial.mergeMessageGapSeconds ?? global.defaultMergeMessageGapSeconds,
    imageReferenceMaxPerCall: resolveImageReferenceMaxPerCall(
      partial.imageReferenceMaxPerCall,
      global.defaultImageReferenceMaxPerCall,
      "imageReferenceMaxPerCall",
    ),
    imageReading: resolveGuildImageReading(global.defaultImageReading, partial.imageReading),
    imageGeneration: resolveGuildImageGeneration(global.defaultImageGeneration, partial.imageGeneration),
    assetReading: resolveAssetReadingConfig(partial.assetReading, global.defaultAssetReading),
    instructions,
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
    typingSimulation: resolveTypingSimulationConfig(global.defaultTypingSimulation, partial.typingSimulation),
    schedulePressure: resolveSchedulePressure(global.defaultSchedulePressure, partial.schedulePressure, "schedulePressure"),
    promptTransport: resolveGuildPromptTransport(global.defaultPromptTransport, partial.promptTransport),
    ambientAttention: resolveAmbientAttentionConfig(global.defaultAmbientAttention, partial.ambientAttention),
    ambientInitiative: resolveAmbientInitiativeConfig(global.defaultAmbientInitiative, partial.ambientInitiative),
    replyLoop: resolveGuildReplyLoop(global.defaultReplyLoop, partial.replyLoop),
    memoryExtraction: resolveGuildMemoryExtraction(global.defaultMemoryExtraction, partial.memoryExtraction),
    memoryContext: resolveMemoryContext(global.defaultMemoryContext, partial.memoryContext),
    relationships: resolveRelationshipConfig(global.defaultRelationships, partial.relationships),
    innerThreads: resolveInnerThreadsConfig(global.defaultInnerThreads, partial.innerThreads),
    notebooks: resolveNotebooksConfig(global.defaultNotebooks, partial.notebooks),
    voice: resolveVoiceConfig(global.defaultVoice ?? DEFAULT_VOICE_CONFIG, partial.voice),
  };
  validateModelProfileReferences(global.modelProfiles, [
    [config.modelProfile, "modelProfile"],
    [config.imageReading.fallbackModelProfile, "imageReading.fallbackModelProfile"],
    [config.imageGeneration.modelProfile, "imageGeneration.modelProfile"],
    [config.memoryExtraction.modelProfile, "memoryExtraction.modelProfile"],
    ...(config.relationships !== undefined
      ? [[config.relationships.modelProfile, "relationships.modelProfile"] as const]
      : []),
    ...(config.innerThreads !== undefined
      ? [[config.innerThreads.modelProfile, "innerThreads.modelProfile"] as const]
      : []),
    ...(config.voice !== undefined
      ? [
        [config.voice.modelProfile, "voice.modelProfile"] as const,
        [config.voice.maintenance.summary.modelProfile, "voice.maintenance.summary.modelProfile"] as const,
        [config.voice.maintenance.extraction.modelProfile, "voice.maintenance.extraction.modelProfile"] as const,
      ]
      : []),
    ...(config.ambientAttention !== undefined
      ? [[config.ambientAttention.evaluator.modelProfile, "ambientAttention.evaluator.modelProfile"] as const]
      : []),
    ...(config.ambientInitiative !== undefined
      ? [[config.ambientInitiative.evaluator.modelProfile, "ambientInitiative.evaluator.modelProfile"] as const]
      : []),
  ]);
  validateContextHistoryConfig(config.contextHistory);
  return config;
}

/** Validate context-history invariants. Throws on violation. */
export function validateContextHistoryConfig(config: ContextHistoryConfig): void {
  if (config.recentMessages < 1) {
    throw new Error("contextHistory.recentMessages must be at least 1");
  }
  if (config.retainedMessages < config.recentMessages) {
    throw new Error("contextHistory.retainedMessages must be >= contextHistory.recentMessages");
  }
  if (config.messageCharLimit < 1) {
    throw new Error("contextHistory.messageCharLimit must be at least 1");
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
    result.set(partial.guildId, resolved);
  }
  return result;
}

/** Persist a resolved guild config back to its YAML file (source of truth). */
export function saveGuildConfig(filePath: string, config: GuildConfig): void {
  // Write only the per-guild fields (not guildId/slug — those are in the filename)
  const yaml: GuildConfigYaml = {
    triggers: config.triggers,
    modelProfile: config.modelProfile,
    timezone: config.timezone,
    contextHistory: config.contextHistory,
    adminUserIds: config.adminUserIds.length > 0 ? config.adminUserIds : undefined,
    mergeMessageGapSeconds: config.mergeMessageGapSeconds,
    imageReferenceMaxPerCall: config.imageReferenceMaxPerCall,
    imageReading: config.imageReading,
    imageGeneration: config.imageGeneration,
    assetReading: config.assetReading,
    instructions: config.instructions !== "" ? config.instructions : undefined,
    tts: config.tts,
    emotes: config.emotes,
    members: config.members,
    dispatcher: config.dispatcher,
    typingSimulation: config.typingSimulation,
    promptTransport: config.promptTransport,
    ambientAttention: config.ambientAttention,
    ambientInitiative: config.ambientInitiative,
    relationships: config.relationships,
    innerThreads: config.innerThreads,
    notebooks: config.notebooks,
    voice: config.voice,
    replyLoop: config.replyLoop,
    memoryExtraction: config.memoryExtraction,
    memoryContext: config.memoryContext,
  };

  // Strip undefined keys before serializing
  const clean = JSON.parse(JSON.stringify(yaml)) as GuildConfigYaml;
  writeFileSync(filePath, stringify(clean));
}
