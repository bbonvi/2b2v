import { describe, expect, test } from "bun:test";
import { resolveModel } from "../llm/client.ts";
import { compactBackgroundTranscript, estimateTranscriptTokens } from "./background-compaction.ts";

describe("background transcript compaction", () => {
  test("counts text and image inputs conservatively", () => {
    expect(estimateTranscriptTokens([{ role: "user", content: "12345678" }])).toBe(4);
    expect(estimateTranscriptTokens([{
      role: "user",
      content: [{ type: "text", text: "1234" }, { type: "image_url", image_url: { url: "data:image/png;base64,x" } }],
    }])).toBeGreaterThan(8_000);
  });

  test("replaces old rounds with a checkpoint and retains the recent turn", async () => {
    const messages = [
      { role: "user" as const, content: "a".repeat(200) },
      { role: "assistant" as const, content: "b".repeat(200) },
      { role: "user" as const, content: "recent work" },
    ];
    await compactBackgroundTranscript({
      messages,
      fixedPromptTokens: 0,
      model: { ...resolveModel("test", "openrouter"), contextWindow: 100 },
      reserveTokens: 10,
      keepRecentTokens: 2,
      complete: () => Promise.resolve({
        text: "## Goal\nContinue the work.",
        toolCalls: [],
        messageForLogs: {},
        rawResponse: {},
      }),
      requestBase: {
        provider: "openrouter",
        apiKey: "test",
        model: "test",
        systemPrompt: "",
      },
      signal: new AbortController().signal,
    });

    expect(messages).toEqual([
      { role: "user", content: "## Background Agent Context Checkpoint\n## Goal\nContinue the work." },
      { role: "user", content: "recent work" },
    ]);
  });

  test("can compact completed tool rounds inside one long-running turn", async () => {
    const messages = [
      { role: "user" as const, content: "one delegated task" },
      { role: "assistant" as const, content: "a".repeat(200) },
      {
        role: "assistant" as const,
        content: "recent round",
        tool_calls: [{ id: "call-1", type: "function" as const, function: { name: "workspace_exec", arguments: "{}" } }],
      },
      { role: "tool" as const, name: "workspace_exec", tool_call_id: "call-1", content: "result" },
    ];
    await compactBackgroundTranscript({
      messages,
      fixedPromptTokens: 0,
      model: { ...resolveModel("test", "openrouter"), contextWindow: 50 },
      reserveTokens: 5,
      keepRecentTokens: 3,
      complete: () => Promise.resolve({ text: "checkpoint", toolCalls: [], messageForLogs: {}, rawResponse: {} }),
      requestBase: { provider: "openrouter", apiKey: "test", model: "test", systemPrompt: "" },
      signal: new AbortController().signal,
    });

    expect(messages[0]?.content).toBe("## Background Agent Context Checkpoint\ncheckpoint");
    expect(messages.slice(1)).toEqual([
      {
        role: "assistant",
        content: "recent round",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "workspace_exec", arguments: "{}" } }],
      },
      { role: "tool", name: "workspace_exec", tool_call_id: "call-1", content: "result" },
    ]);
  });
});
