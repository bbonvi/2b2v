import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { loadInstructionBundle } from "./instruction-bundle.ts";
import { renderPromptTemplate } from "./prompt-template.ts";
import type { Logger } from "../logger.ts";

const TEST_ROOT = join(import.meta.dir, "../../.test-instruction-bundle");
const TEST_DIR = join(TEST_ROOT, "test", "instructions");
const PROFILE_INSTRUCTIONS_DIR = TEST_DIR;

function setup(): void {
  mkdirSync(join(TEST_ROOT, "shared", "instructions"), { recursive: true });
  mkdirSync(join(PROFILE_INSTRUCTIONS_DIR, "system"), { recursive: true });
  mkdirSync(join(PROFILE_INSTRUCTIONS_DIR, "core", "nested"), { recursive: true });
  mkdirSync(join(PROFILE_INSTRUCTIONS_DIR, "runtime", "reply", "tools"), { recursive: true });
  mkdirSync(join(PROFILE_INSTRUCTIONS_DIR, "runtime", "memory", "context"), { recursive: true });
  mkdirSync(join(PROFILE_INSTRUCTIONS_DIR, "runtime", "tools"), { recursive: true });
  mkdirSync(join(PROFILE_INSTRUCTIONS_DIR, "runtime", "tool-parameters", "web_search"), { recursive: true });
  mkdirSync(join(PROFILE_INSTRUCTIONS_DIR, "runtime", "context"), { recursive: true });
  mkdirSync(join(PROFILE_INSTRUCTIONS_DIR, "runtime", "image-reading", "fallback-system"), { recursive: true });
  mkdirSync(join(PROFILE_INSTRUCTIONS_DIR, "runtime", "ambient-attention", "evaluator", "shared"), { recursive: true });
  mkdirSync(join(PROFILE_INSTRUCTIONS_DIR, "runtime", "ambient-attention", "evaluator", "ambient-pickup"), { recursive: true });
  mkdirSync(join(PROFILE_INSTRUCTIONS_DIR, "runtime", "ambient-attention", "evaluator", "lingering-attention"), { recursive: true });
  mkdirSync(join(PROFILE_INSTRUCTIONS_DIR, "runtime", "ambient-attention", "evaluator", "follow-up"), { recursive: true });
  for (const phase of ["evaluator", "generation"]) {
    mkdirSync(join(PROFILE_INSTRUCTIONS_DIR, "runtime", "ambient-initiative", phase, "shared"), { recursive: true });
    mkdirSync(join(PROFILE_INSTRUCTIONS_DIR, "runtime", "ambient-initiative", phase, "self-expression"), { recursive: true });
    mkdirSync(join(PROFILE_INSTRUCTIONS_DIR, "runtime", "ambient-initiative", phase, "targeted-checkin"), { recursive: true });
  }
  mkdirSync(join(PROFILE_INSTRUCTIONS_DIR, "skills", "image_generation"), { recursive: true });
}

function teardown(): void {
  rmSync(TEST_ROOT, { recursive: true, force: true });
}

function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    logTokenUsage: () => {},
    child: () => makeLogger(),
  };
}

describe("loadInstructionBundle", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("loads core instruction markdown deterministically before runtime instructions", () => {
    writeFileSync(join(TEST_DIR, "system", "00-top-level.md"), "# Top Level\ntop");
    writeFileSync(join(TEST_DIR, "core", "10-style.md"), "# Style\nstyle");
    writeFileSync(join(TEST_DIR, "core", "nested", "05-additional-instructions.md"), "extra");
    writeFileSync(join(TEST_DIR, "core", "00-persona.md"), "# Persona\npersona");
    writeFileSync(join(TEST_DIR, "ignored-root.md"), "# Ignored\nignored");
    writeFileSync(join(TEST_DIR, "runtime", "reply", "20-image.md"), "# Image Runtime\nimage");
    writeFileSync(join(TEST_DIR, "runtime", "reply", "10-core.md"), "# Core Runtime\ncore");
    writeFileSync(join(TEST_DIR, "runtime", "reply", "tools", "search.md"), "# Search Runtime\nsearch");
    writeFileSync(join(TEST_DIR, "runtime", "memory", "context", "current.md"), "Memory context.");
    writeFileSync(join(TEST_DIR, "runtime", "tools", "web_search.md"), "Search with {{provider}}.");
    writeFileSync(join(TEST_DIR, "runtime", "tool-parameters", "web_search", "query.md"), "Query for {{provider}}.");
    writeFileSync(join(TEST_DIR, "runtime", "context", "active-image-jobs.md"), "Active jobs.");
    writeFileSync(join(TEST_DIR, "runtime", "context", "relationship-pass-decision.md"), "Relationship decision.");
    writeFileSync(join(TEST_DIR, "runtime", "image-reading", "fallback-system", "00-system.md"), "Describe images.");
    writeFileSync(join(TEST_DIR, "runtime", "ambient-attention", "evaluator", "shared", "00-policy.md"), "Ambient attention shared policy.");
    writeFileSync(join(TEST_DIR, "runtime", "ambient-attention", "evaluator", "ambient-pickup", "00-policy.md"), "Ambient pickup policy.");
    writeFileSync(join(TEST_DIR, "runtime", "ambient-attention", "evaluator", "lingering-attention", "00-policy.md"), "Lingering attention policy.");
    writeFileSync(join(TEST_DIR, "runtime", "ambient-attention", "evaluator", "follow-up", "00-policy.md"), "Follow-up policy.");
    writeFileSync(join(TEST_DIR, "runtime", "ambient-initiative", "evaluator", "shared", "00-policy.md"), "Initiative evaluator shared.");
    writeFileSync(join(TEST_DIR, "runtime", "ambient-initiative", "evaluator", "self-expression", "00-policy.md"), "Initiative evaluator self.");
    writeFileSync(join(TEST_DIR, "runtime", "ambient-initiative", "evaluator", "targeted-checkin", "00-policy.md"), "Initiative evaluator checkin.");
    writeFileSync(join(TEST_DIR, "runtime", "ambient-initiative", "generation", "shared", "00-policy.md"), "Initiative generation shared.");
    writeFileSync(join(TEST_DIR, "runtime", "ambient-initiative", "generation", "self-expression", "00-policy.md"), "Initiative generation self.");
    writeFileSync(join(TEST_DIR, "runtime", "ambient-initiative", "generation", "targeted-checkin", "00-policy.md"), "Initiative generation checkin.");
    writeFileSync(join(TEST_DIR, "skills", "image_generation", "skill.yaml"), [
      "id: image_generation",
      "title: Image Generation",
      "description: Use for creating generated images.",
      "required_for_tools:",
      "  - codex_generate_image",
      "instructions:",
      "  - 00-runtime.md",
      "  - 10-prompting.md",
      "",
    ].join("\n"));
    writeFileSync(join(TEST_DIR, "skills", "image_generation", "00-runtime.md"), "# Runtime\nruntime");
    writeFileSync(join(TEST_DIR, "skills", "image_generation", "10-prompting.md"), "prompting");

    const bundle = loadInstructionBundle(TEST_ROOT, "test", makeLogger());

    expect(bundle.systemDocuments.map((doc) => doc.source.endsWith("00-top-level.md"))).toEqual([true]);
    expect(bundle.systemPrompt).toContain("# Top Level\ntop");
    const sourceNames = bundle.coreDocuments.map((doc) => {
      if (doc.source.endsWith("00-persona.md")) return "persona";
      if (doc.source.endsWith("10-style.md")) return "style";
      return "additional";
    });
    expect(sourceNames).toEqual([
      "persona",
      "style",
      "additional",
    ]);
    expect(bundle.corePrompt).not.toContain("prompt-source");
    expect(bundle.corePrompt).not.toContain("# Top Level");
    expect(bundle.corePrompt).toContain("# Persona\npersona");
    expect(bundle.corePrompt).toContain("# Additional Instructions\n\nextra");
    expect(bundle.corePrompt).not.toContain("# Ignored");
    expect(bundle.runtime.reply.indexOf("# Core Runtime")).toBeLessThan(bundle.runtime.reply.indexOf("# Image Runtime"));
    expect(bundle.runtime.reply.indexOf("# Image Runtime")).toBeLessThan(bundle.runtime.reply.indexOf("# Search Runtime"));
    expect(bundle.runtime.memoryContextTemplates.current).toBe("Memory context.");
    expect(bundle.runtime.toolDescriptions.web_search).toBe("Search with {{provider}}.");
    expect(bundle.runtime.toolParameterDescriptions["web_search/query"]).toBe("Query for {{provider}}.");
    expect(bundle.runtime.contextTemplates["active-image-jobs"]).toBe("Active jobs.");
    expect(bundle.runtime.contextTemplates["relationship-pass-decision"]).toBe("Relationship decision.");
    expect(bundle.runtime.imageDescriptionSystemPrompt).toContain("Describe images.");
    expect(bundle.runtime.ambientAttentionEvaluator.shared).toContain("Ambient attention shared policy.");
    expect(bundle.runtime.ambientAttentionEvaluator.ambientPickup).toContain("Ambient pickup policy.");
    expect(bundle.runtime.ambientAttentionEvaluator.lingeringAttention).toContain("Lingering attention policy.");
    expect(bundle.runtime.ambientAttentionEvaluator.followUp).toContain("Follow-up policy.");
    expect(bundle.runtime.ambientInitiative.evaluator.shared).toContain("Initiative evaluator shared.");
    expect(bundle.runtime.ambientInitiative.evaluator.selfExpression).toContain("Initiative evaluator self.");
    expect(bundle.runtime.ambientInitiative.evaluator.targetedCheckin).toContain("Initiative evaluator checkin.");
    expect(bundle.runtime.ambientInitiative.generation.shared).toContain("Initiative generation shared.");
    expect(bundle.runtime.ambientInitiative.generation.selfExpression).toContain("Initiative generation self.");
    expect(bundle.runtime.ambientInitiative.generation.targetedCheckin).toContain("Initiative generation checkin.");
    expect(bundle.runtime.skills.indexPrompt).toContain("## Skills");
    expect(bundle.runtime.skills.indexPrompt).toContain("- image_generation: Use for creating generated images. Required before: codex_generate_image.");
    expect(bundle.runtime.skills.requiredByTool.codex_generate_image).toBe("image_generation");
    const imageSkill = bundle.runtime.skills.byId.image_generation;
    expect(imageSkill).toBeDefined();
    const imageSkillContent = imageSkill?.content ?? "";
    expect(imageSkillContent).toContain("# Skill: Image Generation");
    expect(imageSkillContent.indexOf("# Runtime")).toBeLessThan(imageSkillContent.indexOf("# Prompting"));
    expect(renderPromptTemplate(bundle.runtime.toolDescriptions.web_search ?? "", { provider: "Brave" })).toBe("Search with Brave.");
    expect(() => renderPromptTemplate(bundle.runtime.toolDescriptions.web_search ?? "")).toThrow("Missing prompt template variable: provider");
  });

  test("layers shared instructions with profile overrides", () => {
    const shared = join(TEST_ROOT, "shared", "instructions");
    const persona = join(TEST_ROOT, "delamain", "instructions");
    mkdirSync(join(shared, "system"), { recursive: true });
    mkdirSync(join(shared, "runtime", "reply"), { recursive: true });
    mkdirSync(join(shared, "runtime", "tools"), { recursive: true });
    mkdirSync(join(shared, "skills", "image_generation"), { recursive: true });
    mkdirSync(join(persona, "core"), { recursive: true });
    mkdirSync(join(persona, "runtime", "reply"), { recursive: true });
    mkdirSync(join(persona, "runtime", "tools"), { recursive: true });
    mkdirSync(join(persona, "skills", "image_generation"), { recursive: true });

    writeFileSync(join(shared, "system", "00-base.md"), "# Shared System\nshared");
    writeFileSync(join(shared, "runtime", "reply", "00-core.md"), "# Shared Reply\nshared reply");
    writeFileSync(join(shared, "runtime", "tools", "web_search.md"), "Shared search.");
    writeFileSync(join(shared, "skills", "image_generation", "skill.yaml"), [
      "id: image_generation",
      "title: Shared Image",
      "description: Shared image skill.",
      "required_for_tools: [codex_generate_image]",
      "instructions: [00-runtime.md]",
    ].join("\n"));
    writeFileSync(join(shared, "skills", "image_generation", "00-runtime.md"), "shared skill");

    writeFileSync(join(persona, "core", "00-persona.md"), "# Delamain\npersona");
    writeFileSync(join(persona, "runtime", "reply", "00-core.md"), "# Persona Reply\npersona reply");
    writeFileSync(join(persona, "runtime", "tools", "web_search.md"), "Persona search.");
    writeFileSync(join(persona, "skills", "image_generation", "skill.yaml"), [
      "id: image_generation",
      "title: Persona Image",
      "description: Persona image skill.",
      "required_for_tools: [codex_generate_image]",
      "instructions: [00-runtime.md]",
    ].join("\n"));
    writeFileSync(join(persona, "skills", "image_generation", "00-runtime.md"), "persona skill");

    const bundle = loadInstructionBundle(TEST_ROOT, "delamain", makeLogger());

    expect(bundle.systemPrompt).toContain("Shared System");
    expect(bundle.corePrompt).toContain("# Delamain");
    expect(bundle.runtime.reply).toContain("Persona Reply");
    expect(bundle.runtime.reply).not.toContain("Shared Reply");
    expect(bundle.runtime.toolDescriptions.web_search).toBe("Persona search.");
    expect(bundle.runtime.skills.byId.image_generation?.title).toBe("Persona Image");
    expect(bundle.runtime.skills.byId.image_generation?.content).toContain("persona skill");
    expect(() => loadInstructionBundle(TEST_ROOT, "missing", makeLogger())).toThrow('Profile "missing" instructions not found');
  });

  test("rejects skill instruction paths that escape the skill directory", () => {
    writeFileSync(join(TEST_DIR, "skills", "image_generation", "skill.yaml"), [
      "id: image_generation",
      "title: Image Generation",
      "description: Use for creating generated images.",
      "required_for_tools: []",
      "instructions:",
      "  - ../escape.md",
      "",
    ].join("\n"));

    expect(() => loadInstructionBundle(TEST_ROOT, "test", makeLogger())).toThrow("escapes skill directory");
  });

  test("rejects duplicate required skill ownership for one tool", () => {
    mkdirSync(join(TEST_DIR, "skills", "other_skill"), { recursive: true });
    writeFileSync(join(TEST_DIR, "skills", "image_generation", "skill.yaml"), [
      "id: image_generation",
      "title: Image Generation",
      "description: Use for creating generated images.",
      "required_for_tools:",
      "  - codex_generate_image",
      "instructions:",
      "  - 00-runtime.md",
      "",
    ].join("\n"));
    writeFileSync(join(TEST_DIR, "skills", "image_generation", "00-runtime.md"), "runtime");
    writeFileSync(join(TEST_DIR, "skills", "other_skill", "skill.yaml"), [
      "id: other_skill",
      "title: Other Skill",
      "description: Also requires the image tool.",
      "required_for_tools:",
      "  - codex_generate_image",
      "instructions:",
      "  - 00-runtime.md",
      "",
    ].join("\n"));
    writeFileSync(join(TEST_DIR, "skills", "other_skill", "00-runtime.md"), "runtime");

    expect(() => loadInstructionBundle(TEST_ROOT, "test", makeLogger())).toThrow("requires multiple skills");
  });

  test("rejects invalid profile names", () => {
    expect(() => loadInstructionBundle(TEST_ROOT, "../delamain", makeLogger())).toThrow("PROFILE must contain only");
  });
});
