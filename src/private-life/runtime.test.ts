import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { markReadOnlyTool } from "../agent/tool-effects.ts";
import { privateLifeToolBlockReason } from "./runtime.ts";

function testTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ content: [], details: {} }),
  };
}

describe("private-life tool authorization", () => {
  test("uses live conditions instead of the suggested action scope", () => {
    const publicAction = testTool("react_to_message");
    const read = markReadOnlyTool(testTool("fetch_url"));

    expect(privateLifeToolBlockReason(publicAction, "day", true)).toBeUndefined();
    expect(privateLifeToolBlockReason(publicAction, "day", false)).toBe(
      "the private-life public-action budget is closed",
    );
    expect(privateLifeToolBlockReason(publicAction, "sleep-window", true)).toBe("2B is asleep");
    expect(privateLifeToolBlockReason(read, "sleep-window", false)).toBeUndefined();
  });
});
