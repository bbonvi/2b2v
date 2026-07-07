import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { isWriteToolName, trackWriteToolStarts } from "./tool-access";

function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ content: [{ type: "text", text: "ok" }], details: {} }),
  };
}

describe("tool access", () => {
  test("classifies visible write tools", () => {
    expect(isWriteToolName("schedule_message")).toBe(true);
    expect(isWriteToolName("codex_generate_image")).toBe(true);
    expect(isWriteToolName("search_channel_messages")).toBe(false);
    expect(isWriteToolName("record_memory")).toBe(false);
  });

  test("tracks write tool starts without blocking execution", async () => {
    const started: string[] = [];
    const tools = trackWriteToolStarts([
      tool("search_channel_messages"),
      tool("schedule_message"),
      tool("fetch_url"),
    ], (name) => started.push(name));

    await tools[0]?.execute("read-1", {}, undefined);
    await tools[1]?.execute("write-1", {}, undefined);
    await tools[2]?.execute("read-2", {}, undefined);

    expect(tools.map((item) => item.name)).toEqual(["search_channel_messages", "schedule_message", "fetch_url"]);
    expect(started).toEqual(["schedule_message"]);
  });
});
