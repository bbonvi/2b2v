import { describe, expect, test } from "bun:test";
import { buildCodexContext } from "./codex-chat.ts";

describe("buildCodexContext", () => {
  test("converts chat-completions-style requests to Codex contexts", () => {
    const context = buildCodexContext({
      provider: "openai-codex",
      apiKey: "codex-token",
      model: "gpt-5.5",
      systemPrompt: "System root",
      responseFormat: { type: "json_object" },
      messages: [
        { role: "system", content: "System from message" },
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: "{\"query\":\"x\"}" },
          }],
        },
        { role: "tool", tool_call_id: "call-1", name: "lookup", content: "tool result" },
      ],
      tools: [{
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup things",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      }],
      toolChoice: "auto",
    });

    expect(context.systemPrompt).toContain("System root");
    expect(context.systemPrompt).toContain("System from message");
    expect(context.systemPrompt).toContain("Return only valid JSON");
    expect(context.tools?.map((tool) => ({ name: tool.name, description: tool.description }))).toEqual([
      { name: "lookup", description: "Lookup things" },
    ]);
    const parameters = context.tools?.[0]?.parameters as unknown;
    expect(parameters).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    expect(context.messages[0]?.content).toEqual([
      { type: "text", text: "What is in this image?" },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ]);
    expect(context.messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { query: "x" } }],
    });
    expect(context.messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "lookup",
      content: [{ type: "text", text: "tool result" }],
    });
  });
});
