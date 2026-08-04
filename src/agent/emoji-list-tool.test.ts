import { describe, expect, test } from "bun:test";
import type { TextContent } from "@earendil-works/pi-ai";
import { buildAllGuildEmojiListOutput, buildEmojiListOutput, createEmojiListTool, type EmojiListToolDeps } from "./emoji-list-tool.ts";
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
    getAllGuildEmojis: () => [{ guildId: "g1", guildName: "Current", emojis: EMOJIS }],
    resolveEmoji: (name) => {
      const emoji = EMOJIS.find((candidate) => candidate.name === name);
      return emoji === undefined ? undefined : { id: emoji.id, animated: emoji.animated };
    },
    ...overrides,
  };
}

describe("buildEmojiListOutput", () => {
  test("formats compact rows and the image URL template", () => {
    const output = buildEmojiListOutput(EMOJIS);

    expect(output).toContain("Available custom emojis (2)");
    expect(output).toContain("Rows: kind | emoji | id (S=static, A=animated)");
    expect(output).toContain("Image URL: https://cdn.discordapp.com/emojis/{id}.png?size=4096");
    expect(output).toContain("S | :wave: | 333");
    expect(output).toContain("A | :dance: | 222");
  });

  test("handles no emojis gracefully", () => {
    expect(buildEmojiListOutput([])).toBe("No custom emojis available for this server.");
  });
});

describe("buildAllGuildEmojiListOutput", () => {
  test("groups current guild first and marks the selected duplicate", () => {
    const output = buildAllGuildEmojiListOutput([
      { guildId: "g2", guildName: "Remote", emojis: [{ name: "wave", id: "222", animated: true }] },
      { guildId: "g1", guildName: "Current", emojis: [{ name: "wave", id: "111", animated: false }] },
    ], "g1", () => ({ id: "111", animated: false }));

    expect(output.indexOf("Server: Current")).toBeLessThan(output.indexOf("Server: Remote"));
    expect(output).toContain("S | :wave: | 111 | duplicate, selected");
    expect(output).toContain("A | :wave: | 222 | duplicate");
  });
});

describe("createEmojiListTool", () => {
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

  test("lists all live guild caches only when requested", async () => {
    let refreshed = false;
    const tool = createEmojiListTool(makeDeps({
      shouldRefresh: () => true,
      refreshEmojis: () => {
        refreshed = true;
        return Promise.resolve(EMOJIS);
      },
      getAllGuildEmojis: () => [
        { guildId: "g2", guildName: "Remote", emojis: [{ name: "remote", id: "444", animated: false }] },
        { guildId: "g1", guildName: "Current", emojis: EMOJIS },
      ],
    }));

    const result = await tool.execute("tc1", { scope: "all" }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;

    expect(refreshed).toBe(false);
    expect(text).toContain("Available custom emojis across 2 servers (3)");
    expect(text).toContain(":remote:");
    expect(result.details).toEqual({ count: 3, guildCount: 2 });
  });
});
