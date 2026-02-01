import { parse, stringify } from "yaml";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "fs";
import { join, basename } from "path";
import type {
  GlobalConfig,
  GuildConfig,
  GuildConfigYaml,
  TriggerConfig,
  TrimConfig,
} from "./types.ts";

const DEFAULT_TRIGGER: TriggerConfig = {
  mention: true,
  keywords: [],
  randomChance: 0,
};

const DEFAULT_TRIM: TrimConfig = {
  trimTrigger: 200,
  trimTarget: 150,
};

/**
 * Build global config from env vars (and defaults for non-secret values).
 * Throws if required secrets are missing.
 */
export function loadGlobalConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): GlobalConfig {
  const discordToken = env.DISCORD_TOKEN;
  if (discordToken === undefined || discordToken === "") throw new Error("DISCORD_TOKEN is required");

  const openrouterApiKey = env.OPENROUTER_API_KEY;
  if (openrouterApiKey === undefined || openrouterApiKey === "") throw new Error("OPENROUTER_API_KEY is required");

  return {
    discordToken,
    openrouterApiKey,
    braveApiKey: env.BRAVE_API_KEY,
    defaultModel: env.DEFAULT_MODEL ?? "moonshotai/kimi-k2.5",
    defaultThinkingLevel: env.DEFAULT_THINKING_LEVEL ?? "medium",
    defaultTimezone: env.DEFAULT_TIMEZONE ?? "UTC",
    defaultTrim: { ...DEFAULT_TRIM },
    defaultMemoryRetentionDays: Number(env.MEMORY_RETENTION_DAYS ?? 180),
    defaultImageMaxDimension: Number(env.IMAGE_MAX_DIMENSION ?? 768),
    personaPath: env.PERSONA_PATH ?? "config/persona.md",
    logLevel: env.LOG_LEVEL ?? "info",
    dataDir: env.DATA_DIR ?? "data",
    modelCacheDir: env.MODEL_CACHE_DIR ?? "model-cache",
    qdrantUrl: env.QDRANT_URL ?? "http://localhost:6333",
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
  return {
    guildId: partial.guildId,
    slug: partial.slug,
    triggers: {
      mention: partial.triggers?.mention ?? DEFAULT_TRIGGER.mention,
      keywords: partial.triggers?.keywords ?? [...DEFAULT_TRIGGER.keywords],
      randomChance: partial.triggers?.randomChance ?? DEFAULT_TRIGGER.randomChance,
    },
    model: partial.model,
    modelParams: partial.modelParams,
    thinkingLevel: partial.thinkingLevel ?? global.defaultThinkingLevel,
    timezone: partial.timezone ?? global.defaultTimezone,
    trim: {
      trimTrigger: partial.trim?.trimTrigger ?? global.defaultTrim.trimTrigger,
      trimTarget: partial.trim?.trimTarget ?? global.defaultTrim.trimTarget,
    },
    memoryRetentionDays: partial.memoryRetentionDays ?? global.defaultMemoryRetentionDays,
    adminUserIds: partial.adminUserIds ?? [],
    imageMaxDimension: partial.imageMaxDimension ?? global.defaultImageMaxDimension,
  };
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
  };

  // Strip undefined keys before serializing
  const clean = JSON.parse(JSON.stringify(yaml)) as GuildConfigYaml;
  writeFileSync(filePath, stringify(clean));
}
