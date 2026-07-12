import { describe, expect, test } from "bun:test";
import { classifyAsset } from "./message-assets.ts";

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
