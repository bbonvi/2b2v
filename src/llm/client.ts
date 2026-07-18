import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  GlobalConfig,
  LlmProvider,
  ModelProfileConfig,
  ThinkingLevel,
} from "../config/types.ts";

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

/** Resolve a named model execution policy, failing before an LLM request can drift to a default. */
export function resolveModelProfile(global: GlobalConfig, profileId: string): ModelProfileConfig {
  const profile = global.modelProfiles[profileId];
  if (profile === undefined) {
    throw new Error(`Unknown model profile "${profileId}"`);
  }
  return profile;
}

/** Resolve the pi-ai model selected by a named profile. */
export function resolveModelProfileModel(global: GlobalConfig, profileId: string): LlmModel {
  const profile = resolveModelProfile(global, profileId);
  return resolveModel(profile.model, profile.provider);
}

/** Return the provider-qualified model key selected by a named profile. */
export function resolveModelProfileKey(global: GlobalConfig, profileId: string): string {
  const profile = resolveModelProfile(global, profileId);
  return `${profile.provider}:${profile.model}`;
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

/** Build provider request options from one complete named model execution policy. */
export function buildModelProfileStreamOptions(
  global: GlobalConfig,
  profileId: string,
): Record<string, unknown> & { apiKey: string } {
  const profile = resolveModelProfile(global, profileId);
  const params = withThinkingLevelParams(
    profile.provider,
    profile.modelParams,
    profile.thinkingLevel,
  );
  if (profile.provider === "openai-codex") {
    return {
      apiKey: "",
      codexAuthPath: global.codexAuthPath,
      ...params,
      ...(profile.serviceTier !== undefined ? { serviceTier: profile.serviceTier } : {}),
      transport: profile.codexTransport,
    };
  }
  if (global.openrouterApiKey === undefined || global.openrouterApiKey === "") {
    throw new Error("OPENROUTER_API_KEY is required for OpenRouter LLM requests");
  }
  return {
    apiKey: global.openrouterApiKey,
    ...params,
    ...(profile.serviceTier !== undefined ? { service_tier: profile.serviceTier } : {}),
  };
}
