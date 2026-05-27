import { describe, test, expect } from "bun:test";
import { createFetchUrlTool } from "./fetch-url-tool.ts";

interface FetchUrlDetails {
  url: string;
  title: string;
  contentLength: number;
  method: string;
}

/** Extract text from first content block (for test assertions). */
function getContentText(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (first?.type === "text" && typeof first.text === "string") {
    return first.text;
  }
  return "";
}

describe("createFetchUrlTool", () => {
  test("uses Jina when available", async () => {
    const tool = createFetchUrlTool({
      fetchFn: (url) => {
        if (url.toString().includes("r.jina.ai")) {
          return Promise.resolve(new Response("# Test Page\n\nContent here.", {
            headers: { "content-type": "text/markdown" },
          }));
        }
        return Promise.reject(new Error("Should not reach manual"));
      },
    });

    const result = await tool.execute("test-id", { url: "https://example.com" });
    const details = result.details as FetchUrlDetails;
    expect(details.method).toBe("jina");
    expect(getContentText(result)).toContain("Source: https://example.com/");
    expect(getContentText(result)).toContain("Test Page");
  });

  test("falls back to manual when Jina fails", async () => {
    const mockHtml = `
      <html><head><title>Fallback Test</title></head>
      <body><article><p>Manual content.</p></article></body></html>
    `;

    const tool = createFetchUrlTool({
      fetchFn: (url) => {
        if (url.toString().includes("r.jina.ai")) {
          return Promise.resolve(new Response("Error", { status: 500 }));
        }
        return Promise.resolve(new Response(mockHtml, { headers: { "content-type": "text/html" } }));
      },
    });

    const result = await tool.execute("test-id", { url: "https://example.com" });
    const details = result.details as FetchUrlDetails;
    expect(details.method).toBe("manual");
  });

  test("rejects invalid URLs", async () => {
    const tool = createFetchUrlTool();
    try {
      await tool.execute("test-id", { url: "not-a-url" });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Invalid URL");
    }
  });

  test("rejects non-HTTP protocols", async () => {
    const tool = createFetchUrlTool();
    try {
      await tool.execute("test-id", { url: "ftp://example.com" });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Only HTTP/HTTPS");
    }
  });

  test("truncates long content", async () => {
    const longContent = "x".repeat(20000);
    const tool = createFetchUrlTool({
      maxContentLength: 100,
      fetchFn: () =>
        Promise.resolve(new Response(`# Title\n\n${longContent}`, {
          headers: { "content-type": "text/markdown" },
        })),
    });

    const result = await tool.execute("test-id", { url: "https://example.com" });
    expect(getContentText(result)).toContain("[Content truncated...]");
  });

  test("disableJina forces manual extraction", async () => {
    const mockHtml = `<html><body><article><p>Manual only.</p></article></body></html>`;

    const tool = createFetchUrlTool({
      disableJina: true,
      fetchFn: () => Promise.resolve(new Response(mockHtml, { headers: { "content-type": "text/html" } })),
    });

    const result = await tool.execute("test-id", { url: "https://example.com" });
    const details = result.details as FetchUrlDetails;
    expect(details.method).toBe("manual");
  });

  test("extracts title from Jina markdown heading", async () => {
    const tool = createFetchUrlTool({
      fetchFn: () =>
        Promise.resolve(new Response("# My Article Title\n\nSome body content.", {
          headers: { "content-type": "text/markdown" },
        })),
    });

    const result = await tool.execute("test-id", { url: "https://example.com/page" });
    const details = result.details as FetchUrlDetails;
    expect(details.title).toBe("My Article Title");
  });

  test("falls back to hostname when no title in Jina response", async () => {
    const tool = createFetchUrlTool({
      fetchFn: () =>
        Promise.resolve(new Response("No heading here, just content.", {
          headers: { "content-type": "text/markdown" },
        })),
    });

    const result = await tool.execute("test-id", { url: "https://example.com/page" });
    const details = result.details as FetchUrlDetails;
    expect(details.title).toBe("example.com");
  });

  test("manual extraction includes source URL in output", async () => {
    const mockHtml = `
      <html><head><title>Test Article</title></head>
      <body><article><p>Article content.</p></article></body></html>
    `;

    const tool = createFetchUrlTool({
      disableJina: true,
      fetchFn: () => Promise.resolve(new Response(mockHtml, { headers: { "content-type": "text/html" } })),
    });

    const result = await tool.execute("test-id", { url: "https://example.com/article" });
    expect(getContentText(result)).toContain("Source: https://example.com/article");
  });

  test("rejects non-HTML content type in manual mode", async () => {
    const tool = createFetchUrlTool({
      disableJina: true,
      fetchFn: () =>
        Promise.resolve(new Response('{"data": "json"}', { headers: { "content-type": "application/json" } })),
    });

    try {
      await tool.execute("test-id", { url: "https://example.com/api" });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Unsupported content type");
    }
  });

  test("handles HTTP errors in manual mode", async () => {
    const tool = createFetchUrlTool({
      disableJina: true,
      fetchFn: () => Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" })),
    });

    try {
      await tool.execute("test-id", { url: "https://example.com/missing" });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("HTTP 404");
    }
  });

  test("times out with clear error", async () => {
    const tool = createFetchUrlTool({
      disableJina: true,
      timeoutMs: 10,
      fetchFn: () => new Promise<Response>(() => {}),
    });

    try {
      await tool.execute("test-id", { url: "https://example.com" });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("fetch_url failed for https://example.com/");
      expect((err as Error).message).toContain("fetch_url timed out after 10ms");
    }
  });

  test("throws when page has no extractable content", async () => {
    // Empty HTML with no textual content at all
    const mockHtml = `<html><head></head><body></body></html>`;

    const tool = createFetchUrlTool({
      disableJina: true,
      fetchFn: () => Promise.resolve(new Response(mockHtml, { headers: { "content-type": "text/html" } })),
    });

    try {
      await tool.execute("test-id", { url: "https://example.com" });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("Could not extract readable content");
    }
  });
});
