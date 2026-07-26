import { describe, expect, test } from "bun:test";
import { assetsFromDiscordMessageData, classifyAsset, extractMessageUrls } from "./message-assets.ts";

describe("classifyAsset", () => {
  test("distinguishes uploaded GIF, media, text, and unknown files", () => {
    expect(classifyAsset("image/gif", "upload.gif")).toBe("gif");
    expect(classifyAsset(null, "upload.gif")).toBe("gif");
    expect(classifyAsset("audio/ogg", "voice.ogg")).toBe("audio");
    expect(classifyAsset("video/mp4", "clip.mp4")).toBe("video");
    expect(classifyAsset("application/json", "data.bin")).toBe("text");
    expect(classifyAsset(null, "notes.ts")).toBe("text");
    expect(classifyAsset("application/pdf", "report.pdf")).toBe("file");
  });
});

describe("message links", () => {
  test("extracts unique HTTP links and trims sentence punctuation", () => {
    expect(extractMessageUrls(
      "See https://example.com/a, https://example.com/a and (https://example.org/b).",
    )).toEqual(["https://example.com/a", "https://example.org/b"]);
  });

  test("records links lazily but leaves a media embed as the media asset", () => {
    const assets = assetsFromDiscordMessageData({
      id: "m1",
      guildId: "g1",
      channelId: "c1",
      createdAt: 1,
      content: "Page https://example.com/post image https://example.com/cat.png",
      attachments: [],
      embeds: [{
        type: "image",
        url: "https://example.com/cat.png",
        image: { url: "https://cdn.example.com/cat.png" },
      }],
      stickers: [],
    });

    const links = assets.filter((asset) => asset.kind === "link");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      sourceKind: "url",
      sourceKey: "https://example.com/post",
      kind: "link",
    });
    expect(assets.filter((asset) => asset.kind === "image")).toHaveLength(1);
  });
});
