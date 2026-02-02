import { describe, test, expect } from "bun:test";
import { createStartTypingTool } from "./start-typing-tool.ts";

describe("createStartTypingTool", () => {
  test("tool has correct name and no parameters", () => {
    const tool = createStartTypingTool(() => {});
    expect(tool.name).toBe("start_typing");
    expect(tool.description).toContain("typing indicator");
  });

  test("execute calls the typing callback", async () => {
    let called = false;
    const tool = createStartTypingTool(() => { called = true; });
    const result = await tool.execute("call-1", {}, undefined as never);
    expect(called).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Typing indicator sent." }]);
  });

  test("execute resolves without error when callback is no-op", async () => {
    const tool = createStartTypingTool(() => {});
    const result = await tool.execute("call-2", {}, undefined as never);
    expect(result.content.length).toBe(1);
  });
});
