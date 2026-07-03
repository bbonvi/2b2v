import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { applyRuntimeToolPrompts } from "./runtime-tool-prompts.ts";
import type { RuntimePromptBundle } from "../config/prompt-bundle.ts";

function runtimePrompts(): RuntimePromptBundle {
  return {
    reply: "",
    finalActionInstruction: "",
    toolDescriptions: {
      demo_tool: "External description for {{name}}.",
    },
    toolParameterDescriptions: {
      "demo_tool/query": "External query description for {{name}}.",
    },
    contextTemplates: {},
    memoryContextTemplates: {},
    imageDescriptionSystemPrompt: "",
    ambientAttentionEvaluator: {
      shared: "",
      ambientPickup: "",
      lingeringAttention: "",
      followUp: "",
    },
    ambientInitiative: {
      evaluator: {
        shared: "",
        selfExpression: "",
        targetedCheckin: "",
      },
      generation: {
        shared: "",
        selfExpression: "",
        targetedCheckin: "",
      },
    },
    relationships: {
      context: "",
    },
    skills: { byId: {}, indexPrompt: "", requiredByTool: {} },
  };
}

function demoTool(): AgentTool {
  return {
    name: "demo_tool",
    label: "Demo Tool",
    description: "Short fallback.",
    parameters: Type.Object({
      query: Type.String({ description: "Fallback query." }),
    }),
    execute: (): Promise<AgentToolResult<Record<string, never>>> => Promise.resolve({
      content: [],
      details: {},
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function queryDescription(value: unknown): string {
  if (!isRecord(value)) throw new Error("expected parameter schema");
  const properties = value.properties;
  if (!isRecord(properties)) throw new Error("expected schema properties");
  const query = properties.query;
  if (!isRecord(query) || typeof query.description !== "string") {
    throw new Error("expected query description");
  }
  return query.description;
}

describe("applyRuntimeToolPrompts", () => {
  test("applies templated tool and parameter descriptions", () => {
    const original = demoTool();
    const [tool] = applyRuntimeToolPrompts([original], runtimePrompts(), {
      demo_tool: { name: "runtime" },
    });

    if (tool === undefined) throw new Error("expected tool");
    expect(tool.description).toBe("External description for runtime.");
    expect(queryDescription(tool.parameters)).toBe("External query description for runtime.");
    expect(original.description).toBe("Short fallback.");
    expect(queryDescription(original.parameters)).toBe("Fallback query.");
  });
});
