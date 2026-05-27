import { describe, expect, test } from "bun:test";
import { prependStableSectionsToPayload, type StablePromptSection } from "./prompt-cache";

function payload(): { messages: unknown[] } {
  return {
    messages: [
      { role: "system", content: "dynamic runtime" },
      { role: "user", content: "hello" },
    ],
  };
}

const stable: StablePromptSection[] = [
  { role: "system", text: "persona" },
  { role: "system", text: "style" },
  { role: "system", text: "tool instructions" },
  { role: "system", text: "older history" },
  { role: "developer", text: "thread metadata" },
];

describe("prependStableSectionsToPayload", () => {
  test("merges stable system sections into one cached content object", () => {
    const body = payload();

    prependStableSectionsToPayload(body, stable, { enabled: true }, "qwen/qwen3-max");

    expect(body.messages).toHaveLength(6);
    const first = body.messages[0] as { role?: unknown; content?: unknown };
    expect(first.role).toBe("system");
    expect(Array.isArray(first.content)).toBe(true);
    expect(first.content).toEqual([{
      type: "text",
      text: "persona\n\nstyle\n\ntool instructions\n\nolder history",
      cache_control: { type: "ephemeral" },
    }]);
    expect(body.messages[1]).toEqual({
      role: "developer",
      content: [{ type: "text", text: "thread metadata", cache_control: { type: "ephemeral" } }],
    });
    expect(body.messages[2]).toEqual({
      role: "user",
      content: "Stable context is loaded. Wait for the current Discord turn.",
    });
    expect(body.messages[3]).toEqual({ role: "assistant", content: "Ready." });
    expect(body.messages[4]).toEqual({ role: "system", content: "dynamic runtime" });
    expect(body.messages[5]).toEqual({ role: "user", content: "hello" });
  });

  test("adds explicit breakpoints by default when prompt caching is enabled", () => {
    const body = payload();

    prependStableSectionsToPayload(body, stable, { enabled: true }, "openai/gpt-5");

    expect(body.messages).toHaveLength(6);
    const first = body.messages[0] as { role?: unknown; content?: unknown };
    expect(first.role).toBe("system");
    expect(Array.isArray(first.content)).toBe(true);
    const content = first.content as Array<{ text?: string; cache_control?: unknown }>;
    expect(content).toHaveLength(1);
    expect(content[0]?.text).toBe("persona\n\nstyle\n\ntool instructions\n\nolder history");
    expect(content[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[1]).toEqual({
      role: "developer",
      content: [{ type: "text", text: "thread metadata", cache_control: { type: "ephemeral" } }],
    });
    expect(body.messages[2]).toEqual({
      role: "user",
      content: "Stable context is loaded. Wait for the current Discord turn.",
    });
    expect(body.messages[3]).toEqual({ role: "assistant", content: "Ready." });
  });

  test("adds explicit breakpoints for DeepSeek too", () => {
    const body = payload();

    prependStableSectionsToPayload(body, stable, { enabled: true }, "deepseek/deepseek-v4-pro");

    const first = body.messages[0] as { content?: unknown };
    expect(Array.isArray(first.content)).toBe(true);
    const parts = first.content as Array<{ cache_control?: unknown }>;
    expect(parts).toHaveLength(1);
    expect(parts[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(body.messages[2]).toEqual({
      role: "user",
      content: "Stable context is loaded. Wait for the current Discord turn.",
    });
  });

  test("does not add breakpoints when prompt caching is disabled", () => {
    const body = payload();

    prependStableSectionsToPayload(body, stable, { enabled: false }, "anthropic/claude-sonnet-4.5");

    expect(body.messages).toHaveLength(4);
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "persona\n\nstyle\n\ntool instructions\n\nolder history",
    });
    expect(body.messages[1]).toEqual({ role: "developer", content: "thread metadata" });
    expect(body.messages[2]).toEqual({ role: "system", content: "dynamic runtime" });
    for (const message of body.messages) {
      const content = (message as { content: unknown }).content;
      if (Array.isArray(content)) {
        expect((content as Array<{ cache_control?: unknown }>)[0]?.cache_control).toBeUndefined();
      }
    }
  });
});
