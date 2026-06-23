import { describe, expect, test } from "bun:test";
import { createLoadSkillTool } from "./load-skill-tool.ts";
import type { PromptSkillBundle } from "../config/prompt-bundle.ts";

function skills(): PromptSkillBundle {
  return {
    byId: {
      image_generation: {
        id: "image_generation",
        title: "Image Generation",
        description: "Use for creating generated images.",
        requiredForTools: ["codex_generate_image"],
        instructionDocuments: [],
        content: "# Skill: Image Generation\n\nPrompt carefully.",
      },
    },
    indexPrompt: "## Skills\n- image_generation: Use for creating generated images. Required before: codex_generate_image.",
    requiredByTool: {
      codex_generate_image: "image_generation",
    },
  };
}

function firstText(result: Awaited<ReturnType<ReturnType<typeof createLoadSkillTool>["execute"]>>): string {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("expected text content");
  return first.text;
}

describe("createLoadSkillTool", () => {
  test("returns skill content for a known skill id", async () => {
    const tool = createLoadSkillTool({ skills: skills() });

    const result = await tool.execute("call-1", { skill: "image_generation" }, undefined);

    expect(result.content[0]?.type).toBe("text");
    expect(firstText(result)).toContain("# Skill: Image Generation");
    expect(result.details).toEqual({
      skillId: "image_generation",
      requiredForTools: ["codex_generate_image"],
    });
  });

  test("reports available skills for an unknown skill id", async () => {
    const tool = createLoadSkillTool({ skills: skills() });

    const result = await tool.execute("call-1", { skill: "missing" }, undefined);

    expect(firstText(result)).toContain("Unknown skill \"missing\"");
    expect(firstText(result)).toContain("image_generation");
    expect(result.details).toEqual({ error: true });
  });
});
