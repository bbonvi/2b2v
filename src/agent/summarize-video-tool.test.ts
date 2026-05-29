import { describe, expect, test } from "bun:test";
import type { TextContent } from "@mariozechner/pi-ai";
import { createSummarizeVideoTool } from "./summarize-video-tool.ts";

interface SummarizeVideoDetails {
  url: string;
  title: string;
  contentLength: number;
  method: string;
}

describe("createSummarizeVideoTool", () => {
  test("extracts content for summarization", async () => {
    const tool = createSummarizeVideoTool({
      fetchFn: () => Promise.resolve(new Response(`
        <html><head><title>Video Page</title></head>
        <body><article><p>Transcript-like content.</p></article></body></html>
      `, { headers: { "content-type": "text/html" } })),
    });

    const result = await tool.execute("test-id", { url: "https://example.com/watch" }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    const details = result.details as SummarizeVideoDetails;
    expect(text).toContain("Transcript-like content.");
    expect(details.title).toBe("Video Page");
    expect(details.method).toBe("summarize-core");
  });

  test("rejects invalid URLs", async () => {
    const tool = createSummarizeVideoTool();
    try {
      await tool.execute("test-id", { url: "not-a-url" }, AbortSignal.timeout(5000));
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Invalid URL");
    }
  });

  test("times out with clear error", async () => {
    const tool = createSummarizeVideoTool({
      timeoutMs: 10,
      fetchFn: () => new Promise<Response>(() => {}),
    });

    try {
      await tool.execute("test-id", { url: "https://example.com/watch" }, AbortSignal.timeout(5000));
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("summarize_video failed for https://example.com/watch");
      expect((err as Error).message).toContain("summarize_video timed out after 10ms");
    }
  });
});
