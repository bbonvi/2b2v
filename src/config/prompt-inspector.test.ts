import { describe, expect, test } from "bun:test";
import { join } from "path";
import { CODEX_IMAGE_GENERATION_INSTRUCTIONS } from "../agent/codex-image-prompts.ts";
import type { Logger } from "../logger.ts";
import { loadInstructionBundle } from "./instruction-bundle.ts";
import { loadGlobalConfig } from "./loader.ts";
import {
  inspectPromptScenario,
  PROMPT_SCENARIO_IDS,
  type PromptScenarioId,
} from "./prompt-inspector.ts";
import type { LlmProvider } from "./types.ts";

const ROOT_DIR = join(import.meta.dir, "../..");
const PROFILES_DIR = join(ROOT_DIR, "profiles");
const PROFILE = "2b";

function quietLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    logTokenUsage: () => {},
    child: () => quietLogger(),
  };
}

const bundle = loadInstructionBundle(PROFILES_DIR, PROFILE, quietLogger());
const config = loadGlobalConfig({
  DISCORD_TOKEN: "test",
  OPENROUTER_API_KEY: "test",
  VPN_API_URL: "https://vpn.example.com",
  VPN_PEER: "vpn-peer",
}, join(PROFILES_DIR, PROFILE, "config.yaml"));

function inspect(scenario: PromptScenarioId, provider: LlmProvider = "openai-codex") {
  return inspectPromptScenario({
    bundle,
    profile: PROFILE,
    scenario,
    provider,
    transport: config.defaultPromptTransport,
  });
}

describe("prompt inspector", () => {
  test("inspects every declared call surface", () => {
    for (const scenario of PROMPT_SCENARIO_IDS) {
      const result = inspect(scenario);
      expect(result.scenario.id).toBe(scenario);
      expect(result.catalog.length).toBeGreaterThan(0);
      expect(result.dynamicSections.length).toBeGreaterThan(0);
    }
  });

  test("distinguishes event-watch overlays from scheduled-task final replacement", () => {
    const watch = inspect("event-watch");
    const scheduled = inspect("scheduled-task");

    expect(watch.documents.some((document) => (
      document.groupId === "surface.event-watch.execution-mode"
      && document.phase === "volatile"
      && document.transportSection === "currentContext"
    ))).toBe(true);
    expect(scheduled.documents.some((document) => document.groupId === "surface.event-watch.execution-mode")).toBe(false);
    expect(scheduled.documents.some((document) => (
      document.groupId === "surface.scheduled-task.execution-mode"
      && document.phase === "final"
    ))).toBe(true);
    expect(scheduled.documents.some((document) => document.groupId === "surface.text.execution-mode")).toBe(false);
  });

  test("shows the voice runtime and final-action replacements", () => {
    const voice = inspect("voice-actor");

    expect(voice.documents.some((document) => document.groupId === "surface.voice.runtime")).toBe(true);
    expect(voice.documents.some((document) => document.groupId === "core.runtime")).toBe(false);
    expect(voice.documents.some((document) => document.groupId === "surface.voice.final-action")).toBe(true);
    expect(voice.documents.some((document) => document.groupId === "surface.text.final-action")).toBe(false);
  });

  test("separates periodic ambient memory review from post-reply maintenance", () => {
    const postReply = inspect("memory-maintenance");
    const ambient = inspect("ambient-memory-maintenance");

    expect(postReply.documents.some((document) => document.groupId === "pass.memory.ambient-review")).toBe(false);
    expect(ambient.documents.some((document) => (
      document.groupId === "pass.memory.ambient-review"
      && document.role === "user"
      && document.target === "input"
    ))).toBe(true);
  });

  test("retains profile override provenance and conditional sources", () => {
    const result = inspect("discord");
    const override = result.catalog.find((entry) => entry.overriddenSources.length > 0);

    expect(override).toBeDefined();
    expect(override?.layer).toBe("profile");
    expect(result.catalog.some((entry) => entry.groupId === "tools.descriptions" && entry.status === "conditional")).toBe(true);
    expect(result.catalog.some((entry) => entry.groupId.startsWith("skill.") && entry.status === "conditional")).toBe(true);
  });

  test("catalogs every effective instruction source", () => {
    const result = inspect("discord");
    const expected = [
      ...Object.entries(bundle.sources.groups).flatMap(([groupId, group]) =>
        group.selections.map((selection) => `${groupId}\0${selection.effective.source}`)
      ),
      ...Object.entries(bundle.sources.maps).flatMap(([groupId, sourceMap]) =>
        Object.values(sourceMap.entries).map((entry) => `${groupId}\0${entry.effective.source}`)
      ),
      ...Object.entries(bundle.runtime.skills.byId).flatMap(([skillId, skill]) =>
        skill.instructionDocuments.map((document) => `skill.${skillId}\0${document.source}`)
      ),
    ].sort();
    const actual = result.catalog
      .map((entry) => `${entry.groupId}\0${entry.source}`)
      .sort();

    expect(actual).toEqual(expected);
  });

  test("reports provider-specific transport placement and assembled output", () => {
    const codex = inspect("discord", "openai-codex");
    const openrouter = inspect("discord", "openrouter");

    expect(codex.transportMode).toBe("split-input");
    expect(codex.assembled.instructions).toContain(bundle.systemPrompt);
    expect(codex.documents.find((document) => document.groupId === "core.system")?.target).toBe("instructions");
    expect(openrouter.assembled.instructions).toBe("");
    expect(openrouter.assembled.input.some((entry) => entry.text.includes(bundle.systemPrompt))).toBe(true);
  });

  test("gives background agents the actor core without guild-scoped prompt context", () => {
    const result = inspect("background-agent");
    const assembled = [result.assembled.instructions, ...result.assembled.input.map((entry) => entry.text)].join("\n");
    const groups = result.documents.map((document) => document.groupId);

    expect(assembled).toContain(bundle.systemPrompt);
    expect(assembled).toContain(bundle.runtime.reply);
    expect(assembled).toContain(bundle.runtime.skills.indexPrompt);
    expect(assembled).toContain(bundle.runtime.backgroundAgent);
    expect(groups).toContain("core.persona");
    expect(groups).toContain("core.style");
    expect(groups).toContain("core.runtime");
    expect(groups).toContain("generated.skills-index");
    expect(groups).toContain("surface.background-agent.runtime");
    expect(result.dynamicSections.some((section) => section.startsWith("Guild, channel"))).toBe(false);
  });

  test("shows custom provider instructions", () => {
    const transport = structuredClone(config.defaultPromptTransport);
    transport.openaiCodex.sections.custom.content = "Use the new feature.";
    const result = inspectPromptScenario({
      bundle,
      profile: PROFILE,
      scenario: "discord",
      provider: "openai-codex",
      transport,
    });
    const custom = result.documents.find((document) => document.transportSection === "custom");

    expect(custom).toMatchObject({
      role: "developer",
      target: "input",
      text: "Use the new feature.",
    });
    expect(result.assembled.input.some((entry) => entry.text === "Use the new feature.")).toBe(true);
  });

  test("places direct evaluator policy in the provider system channel", () => {
    const codex = inspect("ambient-initiative-evaluator", "openai-codex");
    const openrouter = inspect("ambient-initiative-evaluator", "openrouter");

    expect(codex.assembled.instructions).toContain(bundle.runtime.ambientInitiative.evaluator);
    expect(openrouter.assembled.input.some((entry) => entry.role === "system" && entry.target === "input")).toBe(true);
  });

  test("shows rendered current-event templates without claiming their raw source was sent", () => {
    const result = inspect("ambient-initiative-actor");
    const template = result.documents.find((document) =>
      document.groupId === "surface.ambient-initiative.opportunity"
    );

    expect(template?.status).toBe("template");
    expect(template?.phase).toBe("volatile");
    expect(template?.transportSection).toBe("currentTurn");
    expect(result.blocks.some((block) => block.sourceIds.includes(template?.source ?? ""))).toBe(false);
  });

  test("shows relationship context as a rendered volatile template", () => {
    const result = inspect("relationship-maintenance");
    const template = result.documents.find((document) => document.groupId === "pass.relationships.context");

    expect(template?.status).toBe("template");
    expect(template?.phase).toBe("volatile");
    expect(template?.transportSection).toBe("currentContext");
    expect(result.blocks.some((block) => block.sourceIds.includes(template?.source ?? ""))).toBe(false);
  });

  test("covers each Codex image-generation transport", () => {
    const responses = inspect("image-generation", "openrouter");
    const direct = inspect("image-generation-direct");
    const edit = inspect("image-edit-direct");

    expect(responses.provider).toBe("openai-codex");
    expect(responses.scenario.fixedProvider).toBe("openai-codex");
    expect(responses.assembled.instructions).toBe(CODEX_IMAGE_GENERATION_INSTRUCTIONS);
    expect(responses.documents.some((document) =>
      document.source === "src/agent/codex-image-prompts.ts"
      && document.status === "code"
    )).toBe(true);
    expect(direct.documents).toHaveLength(0);
    expect(direct.assembled.instructions).toBe("");
    expect(direct.assembled.input).toHaveLength(0);
    expect(edit.documents).toHaveLength(0);
    expect(edit.assembled.instructions).toBe("");
    expect(edit.assembled.input).toHaveLength(0);
  });
});
