import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { readOnlyToolsForDiscardableTurn } from "./tool-access";

function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ content: [{ type: "text", text: "ok" }], details: {} }),
  };
}

describe("readOnlyToolsForDiscardableTurn", () => {
  test("removes state-changing tools from stale-droppable turns", () => {
    const names = readOnlyToolsForDiscardableTurn([
      tool("search_messages"),
      tool("schedule_message"),
      tool("list_memories"),
      tool("codex_generate_image"),
      tool("react_to_message"),
      tool("fetch_url"),
      tool("record_memory"),
      tool("start_thread"),
    ]).map((item) => item.name);

    expect(names).toEqual(["search_messages", "list_memories", "fetch_url"]);
  });
});
