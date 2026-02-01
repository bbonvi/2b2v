import { getModel } from "@mariozechner/pi-ai";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";

/** Shape of a pi-ai Model object (openai-completions API via OpenRouter). */
export interface LlmModel {
  id: string;
  name: string;
  api: "openai-completions";
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: readonly string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

/**
 * Resolve an OpenRouter model string to a pi-ai Model object.
 * Tries the built-in registry first; falls back to a synthetic model definition
 * for arbitrary OpenRouter model IDs (the API accepts any valid model string).
 */
export function resolveModel(modelId: string): LlmModel {
  const registered = getModel("openrouter", modelId as any);
  if (registered) return registered as unknown as LlmModel;

  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: OPENROUTER_BASE,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

/** Resolve the effective model for a guild (override or global default). */
export function resolveGuildModel(global: GlobalConfig, guild: GuildConfig): LlmModel {
  return resolveModel(guild.model ?? global.defaultModel);
}

/** Build stream options for a pi-ai call, merging API key and guild params. */
export function buildStreamOptions(
  global: GlobalConfig,
  guild: GuildConfig
): Record<string, unknown> & { apiKey: string } {
  const params = guild.modelParams ?? {};
  return {
    apiKey: global.openrouterApiKey,
    ...params,
  };
}
