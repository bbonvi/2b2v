import { describe, expect, test } from "bun:test";
import { buildCodexContext, classifyCodexFailure } from "./codex-chat.ts";

describe("classifyCodexFailure", () => {
  test("classifies transient WebSocket and stream transport failures", () => {
    expect(classifyCodexFailure({ message: "WebSocket closed 1006 Connection ended" })).toMatchObject({
      kind: "transport",
      retryable: true,
      transportCode: 1006,
    });
    expect(classifyCodexFailure({ message: "Stream closed unexpectedly before completion" })).toMatchObject({
      kind: "transport",
      retryable: true,
    });
  });

  test("keeps policy close codes and aborts non-retryable", () => {
    for (const code of [1008, 1009]) {
      expect(classifyCodexFailure({ message: `WebSocket closed ${code}` })).toMatchObject({
        kind: "permanent",
        retryable: false,
        transportCode: code,
      });
    }
    expect(classifyCodexFailure({ message: "request aborted", stopReason: "aborted" })).toMatchObject({
      kind: "aborted",
      retryable: false,
    });
  });
});

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

  test("preserves provider-native assistant reasoning blocks for Codex replay", () => {
    const reasoningItem = {
      type: "reasoning",
      id: "rs_123",
      encrypted_content: "sealed",
      summary: [],
      status: "completed",
    };

    const context = buildCodexContext({
      provider: "openai-codex",
      apiKey: "codex-token",
      model: "gpt-5.5",
      systemPrompt: "System root",
      messages: [
        { role: "user", content: "look this up" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_abc|fc_123",
            type: "function",
            function: { name: "lookup", arguments: "{\"query\":\"fallback\"}" },
          }],
          providerNativeContent: [
            {
              type: "thinking",
              thinking: "",
              thinkingSignature: JSON.stringify(reasoningItem),
            },
            {
              type: "text",
              text: "I'll check.",
              textSignature: "msg_123",
            },
            {
              type: "toolCall",
              id: "call_abc|fc_123",
              name: "lookup",
              arguments: { query: "x" },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_abc|fc_123", name: "lookup", content: "tool result" },
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

    expect(context.messages[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoningItem) },
        { type: "text", text: "I'll check.", textSignature: "msg_123" },
        { type: "toolCall", id: "call_abc|fc_123", name: "lookup", arguments: { query: "x" } },
      ],
    });
    expect(context.messages[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_abc|fc_123",
      toolName: "lookup",
      content: [{ type: "text", text: "tool result" }],
    });
  });
});
