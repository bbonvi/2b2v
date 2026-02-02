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

  test("returns ordered results for valid IDs", async () => {
    const result = await tool.execute("call-1", { image_ids: [2, 1] });
    const text = (result.content[0] as { type: "text"; text: string }).text;
    const parsed = JSON.parse(text) as unknown[];
    expect(parsed).toHaveLength(2);

    const first = parsed[0] as { id: number; mime: string; width: number; height: number; data_base64: string };
    expect(first.id).toBe(2);
    expect(first.mime).toBe("image/jpeg");
    expect(first.width).toBe(400);
    expect(first.height).toBe(300);
    expect(first.data_base64).toBe(Buffer.from("fake-image-2").toString("base64"));

    const second = parsed[1] as { id: number; mime: string; width: number; height: number; data_base64: string };
    expect(second.id).toBe(1);
    expect(second.data_base64).toBe(Buffer.from("fake-image-1").toString("base64"));
  });

  test("returns not_found for missing IDs", async () => {
    const result = await tool.execute("call-2", { image_ids: [1, 999] });
    const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as unknown[];
    expect(parsed).toHaveLength(2);

    const first = parsed[0] as { id: number };
    expect(first.id).toBe(1);
    expect("data_base64" in first).toBe(true);

    const second = parsed[1] as { id: number; error: string };
    expect(second.id).toBe(999);
    expect(second.error).toBe("not_found");
  });

  test("returns not_found when file is missing on disk", async () => {
    const deps = makeDeps({
      readFile: () => null,
    });
    tool = createReadImagesTool(deps);

    const result = await tool.execute("call-3", { image_ids: [1] });
    const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as unknown[];
    const entry = parsed[0] as { id: number; error: string };
    expect(entry.id).toBe(1);
    expect(entry.error).toBe("not_found");
  });

  test("throws when exceeding max per call", () => {
    const deps = makeDeps({ imageReadMaxPerCall: 2 });
    tool = createReadImagesTool(deps);

    expect(() => tool.execute("call-4", { image_ids: [1, 2, 5] })).toThrow("Maximum is 2");
  });

  test("returns empty array for empty input", async () => {
    const result = await tool.execute("call-5", { image_ids: [] });
    const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as unknown[];
    expect(parsed).toEqual([]);
  });

  test("preserves input order exactly", async () => {
    const result = await tool.execute("call-6", { image_ids: [5, 1, 2] });
    const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as Array<{ id: number }>;
    expect(parsed.map((r) => r.id)).toEqual([5, 1, 2]);
  });

  test("handles duplicate IDs", async () => {
    const result = await tool.execute("call-7", { image_ids: [1, 1] });
    const parsed = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as Array<{ id: number }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.id).toBe(1);
    expect(parsed[1]?.id).toBe(1);
  });
});
