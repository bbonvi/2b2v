import { describe, expect, test } from "bun:test";
import type { GlobalConfig, ModelProfileConfig } from "../config/types.ts";
import {
  buildModelProfileStreamOptions,
  fetchOpenRouterModelMetadata,
  imageInputSupportFromMetadata,
  resolveModel,
  resolveModelProfile,
  resolveModelProfileKey,
  resolveModelProfileModel,
  withThinkingLevelParams,
} from "./client.ts";

function profile(
  overrides: Partial<ModelProfileConfig> = {},
): ModelProfileConfig {
  return {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    modelParams: {},
    codexTransport: "websocket-cached",
    promptCaching: { enabled: true },
    ...overrides,
  };
}

const GLOBAL = {
  codexAuthPath: "data/codex-auth.json",
  openrouterApiKey: "or_key_123",
  modelProfiles: {
    main: profile(),
    fast: profile({
      model: "gpt-5.6-terra",
      thinkingLevel: "minimal",
      serviceTier: "priority",
    }),
    openrouter: profile({
      provider: "openrouter",
      model: "moonshotai/kimi-k2.5",
      modelParams: { temperature: 0.4 },
      thinkingLevel: "low",
      serviceTier: "flex",
    }),
  },
} as unknown as GlobalConfig;

describe("resolveModel", () => {
  test("resolves registered and arbitrary OpenRouter models", () => {
    expect(resolveModel("moonshotai/kimi-k2.5").api).toBe("openai-completions");
    expect(resolveModel("some-vendor/custom-model-v3").baseUrl)
      .toBe("https://openrouter.ai/api/v1");
  });

  test("resolves Codex subscription models", () => {
    const model = resolveModel("gpt-5.6-luna", "openai-codex");
    expect(model.api).toBe("openai-codex-responses");
    expect(model.llmProvider).toBe("openai-codex");
    expect(model.input).toContain("image");
  });
});

describe("model profiles", () => {
  test("resolve provider, model, and cache key from one named policy", () => {
    expect(resolveModelProfile(GLOBAL, "fast").serviceTier).toBe("priority");
    expect(resolveModelProfileModel(GLOBAL, "fast").id).toBe("gpt-5.6-terra");
    expect(resolveModelProfileKey(GLOBAL, "fast")).toBe("openai-codex:gpt-5.6-terra");
  });

  test("rejects unknown profile references", () => {
    expect(() => resolveModelProfile(GLOBAL, "missing"))
      .toThrow('Unknown model profile "missing"');
  });

  test("builds Codex options including profile transport, reasoning, and tier", () => {
    const options = buildModelProfileStreamOptions(GLOBAL, "fast");
    expect(options).toMatchObject({
      apiKey: "",
      codexAuthPath: "data/codex-auth.json",
      reasoningEffort: "minimal",
      serviceTier: "priority",
      transport: "websocket-cached",
    });
  });

  test("builds OpenRouter options including profile params, reasoning, and tier", () => {
    const options = buildModelProfileStreamOptions(GLOBAL, "openrouter");
    expect(options).toMatchObject({
      apiKey: "or_key_123",
      temperature: 0.4,
      reasoning: { effort: "low" },
      service_tier: "flex",
    });
  });

  test("requires an OpenRouter key only for OpenRouter requests", () => {
    const withoutKey = { ...GLOBAL, openrouterApiKey: undefined };
    expect(() => buildModelProfileStreamOptions(withoutKey, "main")).not.toThrow();
    expect(() => buildModelProfileStreamOptions(withoutKey, "openrouter"))
      .toThrow("OPENROUTER_API_KEY is required");
  });
});

describe("withThinkingLevelParams", () => {
  test("does not overwrite explicit provider reasoning params", () => {
    expect(withThinkingLevelParams(
      "openai-codex",
      { reasoningEffort: "high" },
      "minimal",
    )).toEqual({ reasoningEffort: "high" });
    expect(withThinkingLevelParams(
      "openrouter",
      { reasoning: { effort: "high" } },
      "minimal",
    )).toEqual({ reasoning: { effort: "high" } });
  });
});

describe("fetchOpenRouterModelMetadata", () => {
  test("reads image input modalities from OpenRouter metadata", async () => {
    const calls: string[] = [];
    const metadata = await fetchOpenRouterModelMetadata({
      modelId: "vendor/vision-model",
      apiKey: "test-key",
      fetchFn: (url, init) => {
        calls.push(url.toString());
        expect(init?.headers).toEqual({ Authorization: "Bearer test-key" });
        return Promise.resolve(Response.json({
          data: [{
            id: "vendor/vision-model",
            canonical_slug: "vendor/vision-model",
            architecture: { input_modalities: ["text", "image"] },
          }],
        }));
      },
    });

    expect(calls[0]).toContain("/models?output_modalities=all");
    expect(metadata).toEqual({
      id: "vendor/vision-model",
      inputModalities: ["text", "image"],
    });
    expect(imageInputSupportFromMetadata(metadata)).toBe("supported");
  });

  test("handles missing and text-only model metadata", async () => {
    const metadata = await fetchOpenRouterModelMetadata({
      modelId: "vendor/missing",
      apiKey: "test-key",
      fetchFn: () => Promise.resolve(Response.json({ data: [] })),
    });
    expect(metadata).toBeNull();
    expect(imageInputSupportFromMetadata(metadata)).toBe("unknown");
    expect(imageInputSupportFromMetadata({
      id: "vendor/text-model",
      inputModalities: ["text"],
    })).toBe("unsupported");
  });
});
