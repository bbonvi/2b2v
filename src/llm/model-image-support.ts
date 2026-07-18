import type { GlobalConfig, GuildConfig } from "../config/types";
import type { Logger } from "../logger";
import {
  fetchOpenRouterModelMetadata,
  imageInputSupportFromMetadata,
  resolveModel,
  resolveModelProfileKey,
  type ModelImageInputSupport,
} from "./client";

const MODEL_METADATA_TIMEOUT_MS = 10_000;

function collectEffectiveModelIds(global: GlobalConfig, _guilds: ReadonlyMap<string, GuildConfig>): string[] {
  const ids = new Set<string>();
  for (const profileId of Object.keys(global.modelProfiles)) {
    ids.add(resolveModelProfileKey(global, profileId));
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export function createModelImageSupportStore(input: {
  log: Logger;
}): {
  refresh: (global: GlobalConfig, guilds: ReadonlyMap<string, GuildConfig>, reason: "startup" | "hot_reload") => Promise<void>;
  get: (global: GlobalConfig, profileId: string) => ModelImageInputSupport;
} {
  const modelImageInputSupport = new Map<string, ModelImageInputSupport>();

  return {
    refresh: async (global, guilds, reason) => {
      const modelIds = collectEffectiveModelIds(global, guilds);
      const next = new Map<string, ModelImageInputSupport>();

      await Promise.all(modelIds.map(async (modelKey) => {
        const splitAt = modelKey.indexOf(":");
        const provider = splitAt === -1 ? "openrouter" : modelKey.slice(0, splitAt);
        const modelId = splitAt === -1 ? modelKey : modelKey.slice(splitAt + 1);
        if (provider === "openai-codex") {
          const model = resolveModel(modelId, "openai-codex");
          const support: ModelImageInputSupport = model.input.includes("image") ? "supported" : "unsupported";
          next.set(modelKey, support);
          input.log.info("codex model metadata loaded from registry", {
            model: modelId,
            reason,
            imageInputSupport: support,
            inputModalities: model.input,
          });
          return;
        }
        if (global.openrouterApiKey === undefined || global.openrouterApiKey === "") {
          next.set(modelKey, "unknown");
          input.log.error("openrouter model metadata fetch skipped", {
            model: modelId,
            reason,
            error: "OPENROUTER_API_KEY is not configured",
          });
          return;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => {
          controller.abort(new Error(`OpenRouter model metadata request timed out after ${MODEL_METADATA_TIMEOUT_MS}ms`));
        }, MODEL_METADATA_TIMEOUT_MS);
        try {
          const metadata = await fetchOpenRouterModelMetadata({
            modelId,
            apiKey: global.openrouterApiKey,
            signal: controller.signal,
          });
          const support = imageInputSupportFromMetadata(metadata);
          next.set(modelKey, support);
          input.log.info("openrouter model metadata loaded", {
            model: modelId,
            reason,
            imageInputSupport: support,
            inputModalities: metadata?.inputModalities ?? [],
          });
        } catch (err) {
          next.set(modelKey, "unknown");
          input.log.error("openrouter model metadata fetch failed", {
            model: modelId,
            reason,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          clearTimeout(timeout);
        }
      }));

      modelImageInputSupport.clear();
      for (const [modelId, support] of next) {
        modelImageInputSupport.set(modelId, support);
      }
    },
    get: (global, profileId) => modelImageInputSupport.get(resolveModelProfileKey(global, profileId)) ?? "unknown",
  };
}
