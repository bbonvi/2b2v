import { describe, test, expect, beforeEach } from "bun:test";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createFetchImagesTool, type FetchImagesToolDeps } from "./fetch-images-tool.ts";

// Real 1x1 JPEG for testing (smallest valid JPEG)
const VALID_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
  0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
  0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
  0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
  0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
  0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d,
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
  0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
  0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
  0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
  0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
  0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
  0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01,
  0x00, 0x00, 0x3f, 0x00, 0xfb, 0xd5, 0xdb, 0x20, 0xa8, 0xf1, 0x7f, 0xff,
  0xd9,
]);

interface FetchDetails {
  fetched: number;
  failed: number;
}

function createMockFetch(responses: Map<string, { ok: boolean; status?: number; statusText?: string; contentType?: string; body?: Buffer }>): FetchImagesToolDeps["fetchFn"] {
  return (url: string | URL) => {
    const urlStr = url.toString();
    const config = responses.get(urlStr);
    if (config === undefined) {
      return Promise.resolve({
        ok: false,
        status: 404,
        statusText: "Not Found",
        headers: new Headers(),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      } as Response);
    }
    return Promise.resolve({
      ok: config.ok,
      status: config.status ?? (config.ok ? 200 : 500),
      statusText: config.statusText ?? (config.ok ? "OK" : "Internal Server Error"),
      headers: new Headers({ "content-type": config.contentType ?? "image/jpeg" }),
      arrayBuffer: () => Promise.resolve(config.body?.buffer ?? new ArrayBuffer(0)),
    } as Response);
  };
}

function makeDeps(overrides?: Partial<FetchImagesToolDeps>): FetchImagesToolDeps {
  return {
    maxImagesPerCall: 5,
    maxDimension: 1024,
    timeoutMs: 15000,
    ...overrides,
  };
}

describe("createFetchImagesTool", () => {
  let tool: AgentTool;

  beforeEach(() => {
    tool = createFetchImagesTool(makeDeps());
  });

  test("returns tool with correct name", () => {
    expect(tool.name).toBe("fetch_images");
  });

  test("fetches and returns valid image", async () => {
    const mockFetch = createMockFetch(new Map([
      ["https://example.com/image.jpg", { ok: true, contentType: "image/jpeg", body: VALID_JPEG }],
    ]));

    tool = createFetchImagesTool(makeDeps({ fetchFn: mockFetch }));
    const result = await tool.execute("call-1", { urls: ["https://example.com/image.jpg"] });

    expect(result.content).toHaveLength(2);
    const meta = result.content[0] as { type: "text"; text: string };
    expect(meta.type).toBe("text");
    const parsed = JSON.parse(meta.text) as { url: string; success: boolean; width: number; height: number };
    expect(parsed.url).toBe("https://example.com/image.jpg");
    expect(parsed.success).toBe(true);
    expect(parsed.width).toBeGreaterThan(0);
    expect(parsed.height).toBeGreaterThan(0);

    const img = result.content[1] as { type: "image"; data: string; mimeType: string };
    expect(img.type).toBe("image");
    expect(img.mimeType).toBe("image/jpeg");
    expect(img.data.length).toBeGreaterThan(0);

    const details = result.details as FetchDetails;
    expect(details.fetched).toBe(1);
    expect(details.failed).toBe(0);
  });

  test("returns error for invalid URL", async () => {
    const mockFetch = createMockFetch(new Map());
    tool = createFetchImagesTool(makeDeps({ fetchFn: mockFetch }));

    const result = await tool.execute("call-2", { urls: ["not-a-valid-url"] });

    expect(result.content).toHaveLength(1);
    const meta = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as { error: string };
    expect(meta.error).toBe("Invalid URL format");
    const details = result.details as FetchDetails;
    expect(details.failed).toBe(1);
    expect(details.fetched).toBe(0);
  });

  test("returns error for non-HTTP protocol", async () => {
    const mockFetch = createMockFetch(new Map());
    tool = createFetchImagesTool(makeDeps({ fetchFn: mockFetch }));

    const result = await tool.execute("call-3", { urls: ["ftp://example.com/image.jpg"] });

    const meta = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as { error: string };
    expect(meta.error).toBe("Only HTTP/HTTPS URLs are supported");
  });

  test("returns error for HTTP error status", async () => {
    const mockFetch = createMockFetch(new Map([
      ["https://example.com/missing.jpg", { ok: false, status: 404, statusText: "Not Found" }],
    ]));
    tool = createFetchImagesTool(makeDeps({ fetchFn: mockFetch }));

    const result = await tool.execute("call-4", { urls: ["https://example.com/missing.jpg"] });

    const meta = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as { error: string };
    expect(meta.error).toBe("HTTP 404: Not Found");
  });

  test("returns error for unsupported content type", async () => {
    const mockFetch = createMockFetch(new Map([
      ["https://example.com/file.txt", { ok: true, contentType: "text/plain", body: Buffer.from("hello") }],
    ]));
    tool = createFetchImagesTool(makeDeps({ fetchFn: mockFetch }));

    const result = await tool.execute("call-5", { urls: ["https://example.com/file.txt"] });

    const meta = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as { error: string };
    expect(meta.error).toBe("Unsupported content type: text/plain");
  });

  test("throws when exceeding max URLs per call", () => {
    tool = createFetchImagesTool(makeDeps({ maxImagesPerCall: 2 }));

    expect(() =>
      tool.execute("call-6", { urls: ["https://a.com/1.jpg", "https://a.com/2.jpg", "https://a.com/3.jpg"] })
    ).toThrow("Maximum is 2");
  });

  test("handles multiple URLs with mixed success/failure", async () => {
    const mockFetch = createMockFetch(new Map([
      ["https://example.com/good.jpg", { ok: true, contentType: "image/jpeg", body: VALID_JPEG }],
      ["https://example.com/bad.jpg", { ok: false, status: 500, statusText: "Server Error" }],
    ]));
    tool = createFetchImagesTool(makeDeps({ fetchFn: mockFetch }));

    const result = await tool.execute("call-7", {
      urls: ["https://example.com/good.jpg", "https://example.com/bad.jpg"],
    });

    // good.jpg: text + image = 2 blocks; bad.jpg: text only = 1 block
    expect(result.content).toHaveLength(3);

    const meta0 = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as { success: boolean };
    expect(meta0.success).toBe(true);

    const meta1 = JSON.parse((result.content[2] as { type: "text"; text: string }).text) as { success: boolean; error: string };
    expect(meta1.success).toBe(false);
    expect(meta1.error).toContain("500");

    const details = result.details as FetchDetails;
    expect(details.fetched).toBe(1);
    expect(details.failed).toBe(1);
  });

  test("returns empty content for empty input", async () => {
    const result = await tool.execute("call-8", { urls: [] });
    expect(result.content).toEqual([]);
    const details = result.details as FetchDetails;
    expect(details.fetched).toBe(0);
    expect(details.failed).toBe(0);
  });

  test("handles timeout gracefully", async () => {
    const abortingFetch: FetchImagesToolDeps["fetchFn"] = (_url, init) => {
      // Simulate abort by checking signal and throwing AbortError
      if (init?.signal !== undefined) {
        const error = new Error("Aborted");
        error.name = "AbortError";
        return Promise.reject(error);
      }
      return Promise.resolve({ ok: false } as Response);
    };

    tool = createFetchImagesTool(makeDeps({ fetchFn: abortingFetch, timeoutMs: 100 }));
    const result = await tool.execute("call-9", { urls: ["https://slow.com/image.jpg"] });

    const meta = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as { error: string };
    expect(meta.error).toContain("timed out");
  });

  test("accepts all allowed MIME types", async () => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
      "image/avif",
      "image/tiff",
    ];

    for (const contentType of allowedTypes) {
      const mockFetch = createMockFetch(new Map([
        ["https://example.com/img", { ok: true, contentType, body: VALID_JPEG }],
      ]));
      tool = createFetchImagesTool(makeDeps({ fetchFn: mockFetch }));

      const result = await tool.execute("call-mime", { urls: ["https://example.com/img"] });
      const meta = JSON.parse((result.content[0] as { type: "text"; text: string }).text) as { success: boolean };
      expect(meta.success).toBe(true);
    }
  });
});
