import { describe, expect, test } from "bun:test";
import type { TextContent } from "@mariozechner/pi-ai";
import { buildEmojiListOutput, createEmojiListTool, type EmojiListToolDeps } from "./emoji-list-tool.ts";
import type { EmojiEntry } from "../discord/emoji-cache.ts";

const EMOJIS: EmojiEntry[] = [
  { name: "wave", id: "333", animated: false },
  { name: "dance", id: "222", animated: true },
];

function makeDeps(overrides: Partial<EmojiListToolDeps> = {}): EmojiListToolDeps {
  return {
    guildId: "g1",
    getCachedEmojis: () => EMOJIS,
    shouldRefresh: () => false,
    refreshEmojis: () => Promise.resolve(EMOJIS),
    ...overrides,
  };
}

describe("buildEmojiListOutput", () => {
  test("formats compact legend and raw rows", () => {
    const output = buildEmojiListOutput(EMOJIS);

    expect(output).toContain("Available custom emojis (2)");
    expect(output).toContain("Legend: S=static, A=animated");
    expect(output).toContain("Rows: kind | name | use | discord");
    expect(output).toContain("S | wave | :wave: | <:wave:333>");
    expect(output).toContain("A | dance | :dance: | <a:dance:222>");
  });

  test("handles no emojis gracefully", () => {
    expect(buildEmojiListOutput([])).toBe("No custom emojis available for this server.");
  });
});

describe("createEmojiListTool", () => {
  test("returns list_emojis AgentTool with discovery guidance", () => {
    const tool = createEmojiListTool(makeDeps());

    expect(tool.name).toBe("list_emojis");
    expect(tool.description).toBe("Discover this server's custom emojis.");
  });

  test("sorts emoji rows by name", async () => {
    const tool = createEmojiListTool(makeDeps());
    const result = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;

    expect(text.indexOf("dance")).toBeLessThan(text.indexOf("wave"));
    expect((result.details as { count: number }).count).toBe(2);
  });

  test("refreshes emojis when the cache is stale", async () => {
    let refreshed = false;
    const tool = createEmojiListTool(makeDeps({
      shouldRefresh: () => true,
      refreshEmojis: () => {
        refreshed = true;
        return Promise.resolve([{ name: "fresh", id: "444", animated: false }]);
      },
    }));

    const result = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;

    expect(refreshed).toBe(true);
    expect(text).toContain("fresh");
  });

  test("uses stale cached emojis if refresh fails", async () => {
    const tool = createEmojiListTool(makeDeps({
      shouldRefresh: () => true,
      refreshEmojis: () => Promise.reject(new Error("Missing Access")),
    }));

    const result = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;

    expect(text).toContain(":dance:");
    expect((result.details as { count: number }).count).toBe(2);
  });
});
