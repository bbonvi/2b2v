import { describe, test, expect, beforeEach } from "bun:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createReadImagesTool, type ReadImagesToolDeps } from "./read-images-tool.ts";

// Fake image records keyed by ID
const fakeImages = new Map<number, { id: number; mime: string; width: number; height: number; path: string }>([
  [1, { id: 1, mime: "image/jpeg", width: 800, height: 600, path: "/tmp/test-images/1.jpg" }],
  [2, { id: 2, mime: "image/jpeg", width: 400, height: 300, path: "/tmp/test-images/2.jpg" }],
  [5, { id: 5, mime: "image/jpeg", width: 1024, height: 768, path: "/tmp/test-images/5.jpg" }],
]);

// Fake file content per path
const fakeFiles = new Map<string, Buffer>([
  ["/tmp/test-images/1.jpg", Buffer.from("fake-image-1")],
  ["/tmp/test-images/2.jpg", Buffer.from("fake-image-2")],
  ["/tmp/test-images/5.jpg", Buffer.from("fake-image-5")],
]);

function makeDeps(overrides?: Partial<ReadImagesToolDeps>): ReadImagesToolDeps {
  return {
    imageReadMaxPerCall: 10,
    getImageById: (id: number) => fakeImages.get(id) ?? null,
    readFile: (path: string) => fakeFiles.get(path) ?? null,
    ...overrides,
  };
}

describe("createReadImagesTool", () => {
  let tool: AgentTool;

  beforeEach(() => {
    tool = createReadImagesTool(makeDeps());
  });

  test("returns tool with correct name", () => {
    expect(tool.name).toBe("read_images");
  });

  test("returns ImageContent blocks for valid IDs", async () => {
    const result = await tool.execute("call-1", { image_ids: [2, 1] });
    // Each found image produces 2 content blocks: text metadata + image
    expect(result.content).toHaveLength(4);

    // First image: id=2
    const meta0 = result.content[0] as { type: "text"; text: string };
    expect(meta0.type).toBe("text");
    const parsed0 = JSON.parse(meta0.text) as { id: number; width: number; height: number };
    expect(parsed0.id).toBe(2);
    expect(parsed0.width).toBe(400);
    expect(parsed0.height).toBe(300);

    const img0 = result.content[1] as { type: "image"; data: string; mimeType: string };
    expect(img0.type).toBe("image");
    expect(img0.mimeType).toBe("image/jpeg");
    expect(img0.data).toBe(Buffer.from("fake-image-2").toString("base64"));

    // Second image: id=1
    const meta1 = result.content[2] as { type: "text"; text: string };
    const parsed1 = JSON.parse(meta1.text) as { id: number };
    expect(parsed1.id).toBe(1);

    const img1 = result.content[3] as { type: "image"; data: string; mimeType: string };
    expect(img1.type).toBe("image");
    expect(img1.data).toBe(Buffer.from("fake-image-1").toString("base64"));
  });

  test("returns text-only not_found for missing IDs", async () => {
    const result = await tool.execute("call-2", { image_ids: [1, 999] });
    // id=1: text + image = 2 blocks; id=999: text only = 1 block
    expect(result.content).toHaveLength(3);

    const errBlock = result.content[2] as { type: "text"; text: string };
    expect(errBlock.type).toBe("text");
    const parsed = JSON.parse(errBlock.text) as { id: number; error: string };
    expect(parsed.id).toBe(999);
    expect(parsed.error).toBe("not_found");
  });

  test("returns not_found when file is missing on disk", async () => {
    const deps = makeDeps({
      readFile: () => null,
    });
    tool = createReadImagesTool(deps);

    const result = await tool.execute("call-3", { image_ids: [1] });
    expect(result.content).toHaveLength(1);
    const entry = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as { id: number; error: string };
    expect(entry.id).toBe(1);
    expect(entry.error).toBe("not_found");
  });

  test("throws when exceeding max per call", () => {
    const deps = makeDeps({ imageReadMaxPerCall: 2 });
    tool = createReadImagesTool(deps);

    expect(() => tool.execute("call-4", { image_ids: [1, 2, 5] })).toThrow("Maximum is 2");
  });

  test("returns empty content for empty input", async () => {
    const result = await tool.execute("call-5", { image_ids: [] });
    expect(result.content).toEqual([]);
  });

  test("preserves input order exactly", async () => {
    const result = await tool.execute("call-6", { image_ids: [5, 1, 2] });
    // 3 images × 2 blocks each = 6 blocks
    expect(result.content).toHaveLength(6);

    const ids = [0, 2, 4].map((i) => {
      const block = result.content[i] as { type: "text"; text: string };
      return (JSON.parse(block.text) as { id: number }).id;
    });
    expect(ids).toEqual([5, 1, 2]);
  });

  test("handles duplicate IDs", async () => {
    const result = await tool.execute("call-7", { image_ids: [1, 1] });
    // 2 images × 2 blocks each = 4 blocks
    expect(result.content).toHaveLength(4);

    const meta0 = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as { id: number };
    const meta1 = JSON.parse((result.content[2] as { type: "text"; text: string }).text) as { id: number };
    expect(meta0.id).toBe(1);
    expect(meta1.id).toBe(1);
  });
});
