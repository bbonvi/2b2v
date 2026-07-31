import {
  DEFAULT_LLM_PROVIDER,
  DEFAULT_PROMPT_CACHING,
  DEFAULT_PROMPT_TRANSPORT,
  PROMPT_TRANSPORT_SECTION_IDS,
} from "./defaults.ts";
import type {
  CodexPromptTransportMode,
  CodexTransport,
  LlmProvider,
  ModelProfileConfig,
  ModelProfileConfigYaml,
  PromptTransportConfig,
  PromptTransportConfigYaml,
  PromptTransportRole,
  PromptTransportSectionConfig,
  PromptTransportSectionId,
  PromptTransportTarget,
  ProviderPromptTransportConfigYaml,
  ServiceTier,
  ThinkingLevel,
} from "./types.ts";

function clonePromptTransport(config: PromptTransportConfig): PromptTransportConfig {
  return {
    openaiCodex: {
      mode: config.openaiCodex.mode,
      sections: Object.fromEntries(
        PROMPT_TRANSPORT_SECTION_IDS.map((id) => [id, { ...config.openaiCodex.sections[id] }]),
      ) as Record<PromptTransportSectionId, PromptTransportSectionConfig>,
    },
    openrouter: {
      mode: config.openrouter.mode,
      sections: Object.fromEntries(
        PROMPT_TRANSPORT_SECTION_IDS.map((id) => [id, { ...config.openrouter.sections[id] }]),
      ) as Record<PromptTransportSectionId, PromptTransportSectionConfig>,
    },
  };
}

function parsePromptTransportRole(value: unknown, key: string): PromptTransportRole | undefined {
  if (value === undefined) return undefined;
  if (value === "system" || value === "developer" || value === "user") return value;
  throw new Error(`${key} must be "system", "developer", or "user"`);
}

function parsePromptTransportTarget(value: unknown, key: string): PromptTransportTarget | undefined {
  if (value === undefined) return undefined;
  if (value === "instructions" || value === "input") return value;
  throw new Error(`${key} must be "instructions" or "input"`);
}

function parsePromptTransportContent(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw new Error(`${key} must be a string`);
}

function parseCodexPromptTransportMode(value: unknown, key: string): CodexPromptTransportMode | undefined {
  if (value === undefined) return undefined;
  if (value === "legacy-instructions" || value === "split-input") return value;
  throw new Error(`${key}.mode must be "legacy-instructions" or "split-input"`);
}

function validatePromptTransportSectionKeys(
  sections: ProviderPromptTransportConfigYaml["sections"] | undefined,
  key: string,
): void {
  if (sections === undefined) return;
  const allowed = new Set<string>(PROMPT_TRANSPORT_SECTION_IDS);
  for (const sectionId of Object.keys(sections)) {
    if (!allowed.has(sectionId)) {
      throw new Error(`${key}.sections.${sectionId} is not a known prompt transport section`);
    }
  }
}

function resolveProviderPromptTransport(
  base: PromptTransportConfig["openaiCodex"],
  partial: ProviderPromptTransportConfigYaml | undefined,
  key: string,
): PromptTransportConfig["openaiCodex"] {
  validatePromptTransportSectionKeys(partial?.sections, key);
  const sections = Object.fromEntries(
    PROMPT_TRANSPORT_SECTION_IDS.map((id) => {
      const baseSection = base.sections[id];
      const partialSection = partial?.sections?.[id];
      return [id, {
        role: parsePromptTransportRole(partialSection?.role, `${key}.sections.${id}.role`) ?? baseSection.role,
        target: parsePromptTransportTarget(partialSection?.target, `${key}.sections.${id}.target`) ?? baseSection.target,
        cacheGroup: partialSection?.cacheGroup ?? baseSection.cacheGroup,
        ...(id === "custom"
          ? { content: parsePromptTransportContent(partialSection?.content, `${key}.sections.custom.content`) ?? baseSection.content ?? "" }
          : {}),
      }];
    }),
  ) as Record<PromptTransportSectionId, PromptTransportSectionConfig>;

  return {
    mode: parseCodexPromptTransportMode(partial?.mode, key) ?? base.mode,
    sections,
  };
}

function validateOpenAiCodexPromptTransport(config: PromptTransportConfig["openaiCodex"]): void {
  for (const sectionId of PROMPT_TRANSPORT_SECTION_IDS) {
    const section = config.sections[sectionId];
    if (section.role === "system" && section.target === "input") {
      throw new Error(`promptTransport.openaiCodex.sections.${sectionId} cannot use role "system" with target "input"; Codex input messages do not allow system roles`);
    }
  }
}

export function resolveGlobalPromptTransport(
  partial: PromptTransportConfigYaml | undefined,
): PromptTransportConfig {
  const defaults = clonePromptTransport(DEFAULT_PROMPT_TRANSPORT);
  const openaiCodex = resolveProviderPromptTransport(defaults.openaiCodex, partial?.openaiCodex, "promptTransport.openaiCodex");
  validateOpenAiCodexPromptTransport(openaiCodex);
  return {
    openaiCodex,
    openrouter: resolveProviderPromptTransport(defaults.openrouter, partial?.openrouter, "promptTransport.openrouter"),
  };
}

export function resolveGuildPromptTransport(
  global: PromptTransportConfig,
  partial: PromptTransportConfigYaml | undefined,
): PromptTransportConfig {
  const openaiCodex = resolveProviderPromptTransport(global.openaiCodex, partial?.openaiCodex, "promptTransport.openaiCodex");
  validateOpenAiCodexPromptTransport(openaiCodex);
  return {
    openaiCodex,
    openrouter: resolveProviderPromptTransport(global.openrouter, partial?.openrouter, "promptTransport.openrouter"),
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
    || value === "max"
  ) {
    return value;
  }
  throw new Error(`${key} must be "minimal", "low", "medium", "high", "xhigh", or "max"`);
}

function parseCodexTransport(value: unknown, key: string): CodexTransport | undefined {
  if (value === undefined) return undefined;
  if (value === "sse" || value === "websocket" || value === "websocket-cached" || value === "auto") {
    return value;
  }
  throw new Error(`${key} must be "sse", "websocket", "websocket-cached", or "auto"`);
}

function parseServiceTier(value: unknown, keyPrefix: string): ServiceTier | undefined {
  if (value === undefined) return undefined;
  if (value === "flex" || value === "priority") return value;
  throw new Error(`${keyPrefix}.serviceTier must be "flex" or "priority"`);
}

export function resolveModelProfiles(
  partial: Record<string, ModelProfileConfigYaml> | undefined,
): Record<string, ModelProfileConfig> {
  const source = partial ?? {
    main: {
      provider: DEFAULT_LLM_PROVIDER,
      model: "moonshotai/kimi-k2.5",
      codexTransport: "websocket-cached",
    },
  };
  const resolved: Record<string, ModelProfileConfig> = {};
  for (const [id, profile] of Object.entries(source)) {
    if (id.trim() === "") throw new Error("modelProfiles keys must not be empty");
    const provider = parseLlmProvider(profile.provider, `modelProfiles.${id}.provider`);
    if (provider === undefined) throw new Error(`modelProfiles.${id}.provider is required`);
    if (typeof profile.model !== "string" || profile.model.trim() === "") {
      throw new Error(`modelProfiles.${id}.model must not be empty`);
    }
    resolved[id] = {
      provider,
      model: profile.model,
      modelParams: { ...profile.modelParams },
      thinkingLevel: parseThinkingLevel(profile.thinkingLevel, `modelProfiles.${id}.thinkingLevel`),
      serviceTier: parseServiceTier(profile.serviceTier, `modelProfiles.${id}`),
      codexTransport: parseCodexTransport(profile.codexTransport, `modelProfiles.${id}.codexTransport`)
        ?? "websocket-cached",
      promptCaching: {
        enabled: profile.promptCaching?.enabled ?? DEFAULT_PROMPT_CACHING.enabled,
      },
    };
  }
  if (Object.keys(resolved).length === 0) throw new Error("modelProfiles must define at least one profile");
  return resolved;
}

export function requireModelProfile(
  profiles: Record<string, ModelProfileConfig>,
  id: string,
  path: string,
): string {
  if (id.trim() === "") throw new Error(`${path} must not be empty`);
  if (profiles[id] === undefined) throw new Error(`${path} references unknown model profile "${id}"`);
  return id;
}

export function validateModelProfileReferences(
  profiles: Record<string, ModelProfileConfig>,
  references: ReadonlyArray<readonly [id: string, path: string]>,
): void {
  for (const [id, path] of references) {
    requireModelProfile(profiles, id, path);
  }
}


