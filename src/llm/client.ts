import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { GlobalConfig, GuildConfig, LlmProvider, ThinkingLevel } from "../config/types.ts";

/** Shape of a pi-ai Model object used by this bot. */
export interface LlmModel extends Model<"openai-completions" | "openai-codex-responses"> {
  llmProvider: LlmProvider;
}

export type ModelImageInputSupport = "supported" | "unsupported" | "unknown";

export interface OpenRouterModelMetadata {
  id: string;
  inputModalities: readonly string[];
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const CODEX_BASE = "https://chatgpt.com/backend-api";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    result.push(item);
  }
  return result;
}

/**
 * Resolve a model string to a pi-ai Model object for the selected backend.
 * Tries the built-in registry first; falls back to a synthetic model definition
 * for arbitrary provider model IDs where the backend accepts raw model strings.
 */
export function resolveModel(modelId: string, provider: LlmProvider = "openrouter"): LlmModel {
  if (provider === "openai-codex") return resolveCodexModel(modelId);
  return resolveOpenRouterModel(modelId);
}

function withLlmProvider(model: LlmModel, provider: LlmProvider): LlmModel {
  return { ...model, llmProvider: provider };
}

function resolveOpenRouterModel(modelId: string): LlmModel {
  const registered = getBuiltinModels("openrouter").find((model) => model.id === modelId) as LlmModel | undefined;
  if (registered !== undefined) return withLlmProvider(registered, "openrouter");

  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "openrouter",
    llmProvider: "openrouter",
    baseUrl: OPENROUTER_BASE,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

function resolveCodexModel(modelId: string): LlmModel {
  const registered = getBuiltinModels("openai-codex").find((model) => model.id === modelId) as LlmModel | undefined;
  if (registered !== undefined) return withLlmProvider(registered, "openai-codex");

  return {
    id: modelId,
    name: modelId,
    api: "openai-codex-responses",
    provider: "openai-codex",
    llmProvider: "openai-codex",
    baseUrl: CODEX_BASE,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  };
}

/** Resolve the effective model for a guild (override or global default). */
export function resolveGuildModel(global: GlobalConfig, guild: GuildConfig): LlmModel {
  return resolveModel(guild.model ?? global.defaultModel, resolveGuildLlmProvider(global, guild));
}

/** Return the effective model id for a guild. */
export function resolveGuildModelId(global: GlobalConfig, guild: GuildConfig): string {
  return guild.model ?? global.defaultModel;
}

/** Return the effective main LLM provider for a guild. */
export function resolveGuildLlmProvider(global: GlobalConfig, guild: GuildConfig): LlmProvider {
  return guild.llmProvider ?? global.defaultLlmProvider;
}

/** Return the effective provider-qualified model key for cache maps and logs. */
export function resolveGuildModelKey(global: GlobalConfig, guild: GuildConfig): string {
  return `${resolveGuildLlmProvider(global, guild)}:${resolveGuildModelId(global, guild)}`;
}

/** Convert OpenRouter model metadata into the image-input support state used by the agent loop. */
export function imageInputSupportFromMetadata(metadata: OpenRouterModelMetadata | null): ModelImageInputSupport {
  if (metadata === null) return "unknown";
  return metadata.inputModalities.includes("image") ? "supported" : "unsupported";
}

/** Merge the friendly config-level thinking setting into provider-specific request params. */
export function withThinkingLevelParams(
  provider: LlmProvider,
  params: Record<string, unknown>,
  thinkingLevel: ThinkingLevel | undefined,
): Record<string, unknown> {
  if (thinkingLevel === undefined) return { ...params };
  if (provider === "openai-codex") {
    return params.reasoningEffort === undefined
      ? { ...params, reasoningEffort: thinkingLevel }
      : { ...params };
  }

  return params.reasoning === undefined
    ? { ...params, reasoning: { effort: thinkingLevel } }
    : { ...params };
}

/**
 * Fetch live OpenRouter model metadata and return the selected model's input modalities.
 * OpenRouter exposes this under `/models`; `output_modalities=all` avoids hiding non-text models.
 */
export async function fetchOpenRouterModelMetadata(input: {
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  fetchFn?: FetchLike;
  signal?: AbortSignal;
}): Promise<OpenRouterModelMetadata | null> {
  const fetchFn = input.fetchFn ?? fetch;
  const base = (input.baseUrl ?? OPENROUTER_BASE).replace(/\/$/, "");
  const url = new URL(`${base}/models`);
  url.searchParams.set("output_modalities", "all");

  const response = await fetchFn(url, {
    signal: input.signal,
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
    },
  });

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    raw = null;
  }

  if (!response.ok) {
    const errorRecord = asRecord(asRecord(raw)?.error);
    const message = typeof errorRecord?.message === "string" && errorRecord.message !== ""
      ? errorRecord.message
      : `OpenRouter models metadata request failed: ${response.status}`;
    throw new Error(message);
  }

  const rawRecord = asRecord(raw);
  const data = rawRecord?.data;
  if (!Array.isArray(data)) {
    throw new Error("OpenRouter models metadata response missing data array");
  }

  for (const item of data) {
    const model = asRecord(item);
    if (model === null) continue;
    const id = typeof model.id === "string" ? model.id : undefined;
    const canonicalSlug = typeof model.canonical_slug === "string" ? model.canonical_slug : undefined;
    if (id !== input.modelId && canonicalSlug !== input.modelId) continue;

    const architecture = asRecord(model.architecture);
    const inputModalities = stringArray(architecture?.input_modalities);
    if (id === undefined || inputModalities === null) {
      throw new Error(`OpenRouter metadata for ${input.modelId} is missing input modalities`);
    }
    return { id, inputModalities };
  }

  return null;
}

/** Build stream options for a pi-ai call, merging API key and guild params. */
export function buildStreamOptions(
  global: GlobalConfig,
  guild: GuildConfig
): Record<string, unknown> & { apiKey: string } {
  const provider = resolveGuildLlmProvider(global, guild);
  const params = withThinkingLevelParams(provider, guild.modelParams ?? {}, guild.thinkingLevel);
  if (provider === "openai-codex") {
    return {
      apiKey: "",
      codexAuthPath: global.codexAuthPath,
      ...params,
      transport: global.codexTransport,
    };
  }
  if (global.openrouterApiKey === undefined || global.openrouterApiKey === "") {
    throw new Error("OPENROUTER_API_KEY is required for OpenRouter LLM requests");
  }
  return {
    apiKey: global.openrouterApiKey,
    ...params,
  };
}

/** Build OpenRouter options for background LLM calls. */
export function buildBackgroundStreamOptions(
  global: GlobalConfig,
  guild: GuildConfig
): Record<string, unknown> & { apiKey: string } {
  const provider = guild.backgroundLlm.provider ?? resolveGuildLlmProvider(global, guild);
  const params = withThinkingLevelParams(provider, guild.backgroundLlm.modelParams, guild.backgroundLlm.thinkingLevel);
  if (provider === "openai-codex") {
    return {
      apiKey: "",
      codexAuthPath: global.codexAuthPath,
      ...params,
      transport: global.codexTransport,
      ...(guild.backgroundLlm.serviceTier !== undefined ? { serviceTier: guild.backgroundLlm.serviceTier } : {}),
    };
  }
  if (global.openrouterApiKey === undefined || global.openrouterApiKey === "") {
    throw new Error("OPENROUTER_API_KEY is required for OpenRouter background LLM requests");
  }
  return {
    apiKey: global.openrouterApiKey,
    ...params,
    ...(guild.backgroundLlm.serviceTier !== undefined ? { service_tier: guild.backgroundLlm.serviceTier } : {}),
  };
}

/** Build provider options for ambient attention evaluator calls. */
export function buildAmbientAttentionStreamOptions(
  global: GlobalConfig,
  guild: GuildConfig,
): Record<string, unknown> & { apiKey: string } {
  const ambient = guild.ambientAttention;
  if (ambient === undefined) {
    throw new Error("ambientAttention is not configured for this guild");
  }
  const provider = ambient.evaluator.provider ?? resolveGuildLlmProvider(global, guild);
  const params = withThinkingLevelParams(provider, ambient.evaluator.modelParams, ambient.evaluator.thinkingLevel);
  if (provider === "openai-codex") {
    return {
      apiKey: "",
      codexAuthPath: global.codexAuthPath,
      ...params,
      transport: global.codexTransport,
      ...(ambient.evaluator.serviceTier !== undefined ? { serviceTier: ambient.evaluator.serviceTier } : {}),
    };
  }
  if (global.openrouterApiKey === undefined || global.openrouterApiKey === "") {
    throw new Error("OPENROUTER_API_KEY is required for OpenRouter ambient attention requests");
  }
  return {
    apiKey: global.openrouterApiKey,
    ...params,
    ...(ambient.evaluator.serviceTier !== undefined ? { service_tier: ambient.evaluator.serviceTier } : {}),
  };
}

/** Build provider options for ambient initiative evaluator calls. */
export function buildAmbientInitiativeStreamOptions(
  global: GlobalConfig,
  guild: GuildConfig,
): Record<string, unknown> & { apiKey: string } {
  const initiative = guild.ambientInitiative;
  if (initiative === undefined) {
    throw new Error("ambientInitiative is not configured for this guild");
  }
  const provider = initiative.evaluator.provider ?? resolveGuildLlmProvider(global, guild);
  const params = withThinkingLevelParams(provider, initiative.evaluator.modelParams, initiative.evaluator.thinkingLevel);
  if (provider === "openai-codex") {
    return {
      apiKey: "",
      codexAuthPath: global.codexAuthPath,
      ...params,
      transport: global.codexTransport,
      ...(initiative.evaluator.serviceTier !== undefined ? { serviceTier: initiative.evaluator.serviceTier } : {}),
    };
  }
  if (global.openrouterApiKey === undefined || global.openrouterApiKey === "") {
    throw new Error("OPENROUTER_API_KEY is required for OpenRouter ambient initiative requests");
  }
  return {
    apiKey: global.openrouterApiKey,
    ...params,
    ...(initiative.evaluator.serviceTier !== undefined ? { service_tier: initiative.evaluator.serviceTier } : {}),
  };
}

/** Build OpenRouter options for fallback image-description calls. */
export function buildImageReadingStreamOptions(
  global: GlobalConfig,
  guild: GuildConfig,
): Record<string, unknown> & { apiKey: string } {
  const provider = guild.imageReading.fallbackProvider ?? "openrouter";
  if (provider === "openai-codex") {
    return {
      apiKey: "",
      codexAuthPath: global.codexAuthPath,
      ...guild.imageReading.fallbackModelParams,
      transport: global.codexTransport,
    };
  }
  if (global.openrouterApiKey === undefined || global.openrouterApiKey === "") {
    throw new Error("OPENROUTER_API_KEY is required for OpenRouter image fallback LLM requests");
  }
  return {
    apiKey: global.openrouterApiKey,
    ...guild.imageReading.fallbackModelParams,
  };
}
