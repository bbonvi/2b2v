import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  getRuntimeToolEffect,
  isReadOnlyTool,
  isToolAllowedInMaintenance,
  markReadOnlyTool,
  withRuntimeToolEffect,
} from "./tool-effects.ts";

function testTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: () => Promise.resolve({
      content: [{ type: "text", text: "ok" }],
      details: {},
    }),
  };
}

describe("runtime tool effects", () => {
  test("defaults unclassified tools to state-changing", () => {
    const tool = testTool("unknown_tool");

    expect(getRuntimeToolEffect(tool)).toBe("write");
    expect(isReadOnlyTool(tool)).toBe(false);
    expect(isToolAllowedInMaintenance(tool, "record_memory")).toBe(false);
  });

  test("allows every explicitly read-only tool in maintenance", () => {
    const tool = markReadOnlyTool(testTool("inspect_something"));

    expect(getRuntimeToolEffect(tool)).toBe("read");
    expect(isToolAllowedInMaintenance(tool, "record_relationship")).toBe(true);
    expect(isToolAllowedInMaintenance(tool, "record_inner_threads")).toBe(true);
  });

  test("allows only the selected maintenance write tool", () => {
    expect(isToolAllowedInMaintenance(testTool("record_memory"), "record_memory")).toBe(true);
    expect(isToolAllowedInMaintenance(testTool("record_relationship"), "record_memory")).toBe(false);
  });

  test("keeps agent-state tools blocked", () => {
    const tool = withRuntimeToolEffect(testTool("load_skill"), "agent_state");

    expect(isToolAllowedInMaintenance(tool, "record_memory")).toBe(false);
  });

  test("preserves classification through prompt-style object spreads", () => {
    const tool = markReadOnlyTool(testTool("inspect_something"));
    const cloned: AgentTool = { ...tool };

    expect(isReadOnlyTool(cloned)).toBe(true);
  });
});
