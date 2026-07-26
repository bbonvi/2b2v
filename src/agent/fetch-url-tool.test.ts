import { describe, expect, test } from "bun:test";
import { createFetchUrlTool } from "./fetch-url-tool.ts";
import { LinkContentCache } from "./link-content.ts";

function text(result: Awaited<ReturnType<ReturnType<typeof createFetchUrlTool>["execute"]>>): string {
  return result.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

const article = `<!doctype html><html><head><title>Example</title></head><body><article>
  <h1>Example</h1><p>alpha</p><p>beta</p><p>gamma</p><p>delta</p>
</article></body></html>`;

describe("fetch_url", () => {
  test("paginates one cached fetch", async () => {
    let calls = 0;
    const tool = createFetchUrlTool({
      cache: new LinkContentCache(),
      fetchFn: () => {
        calls += 1;
        return Promise.resolve(new Response(article, { headers: { "content-type": "text/html" } }));
      },
    });

    const first = await tool.execute("first", { url: "https://example.com/post", line_count: 2 });
    const firstDetails = first.details as { endLine?: number; totalLines?: number; cacheStatus?: string };
    expect(firstDetails.cacheStatus).toBe("miss_stored");
    expect(firstDetails.totalLines).toBeGreaterThan(2);
    const second = await tool.execute("second", {
      url: "https://example.com/post",
      start_line: (firstDetails.endLine ?? 0) + 1,
      line_count: 2,
    });
    expect((second.details as { cacheStatus?: string }).cacheStatus).toBe("hit");
    expect(calls).toBe(1);
  });

  test("searches readable and raw views", async () => {
    const html = `<!doctype html><html><head><title>Data</title><script type="application/ld+json">{"secret":"needle"}</script></head>
      <body><article><p>visible phrase</p></article></body></html>`;
    const tool = createFetchUrlTool({
      cache: new LinkContentCache(),
      fetchFn: () => Promise.resolve(new Response(html, { headers: { "content-type": "text/html" } })),
    });

    const readable = await tool.execute("readable", { url: "https://example.com", pattern: "visible phrase" });
    expect(text(readable)).toContain("visible phrase");
    const raw = await tool.execute("raw", { url: "https://example.com", pattern: "needle", raw: true });
    expect(text(raw)).toContain("needle");
    expect((raw.details as { cacheStatus?: string }).cacheStatus).toBe("hit");
  });

  test("splits a long raw HTML line into ranges", async () => {
    const html = `<!doctype html><html><body><article><p>ok</p></article><script>${"x".repeat(9_000)}</script></body></html>`;
    const tool = createFetchUrlTool({
      cache: new LinkContentCache(),
      fetchFn: () => Promise.resolve(new Response(html, { headers: { "content-type": "text/html" } })),
    });
    const result = await tool.execute("raw", { url: "https://example.com", raw: true, line_count: 2 });
    expect((result.details as { totalLines?: number }).totalLines).toBeGreaterThan(2);
    expect(text(result)).toContain("More content exists");
  });

  test("supports refresh and bypass without replacing refreshed content", async () => {
    let calls = 0;
    const tool = createFetchUrlTool({
      cache: new LinkContentCache(),
      fetchFn: () => {
        calls += 1;
        return Promise.resolve(new Response(article.replace("alpha", `alpha-${calls}`), {
          headers: { "content-type": "text/html" },
        }));
      },
    });
    await tool.execute("first", { url: "https://example.com" });
    const refreshed = await tool.execute("refresh", { url: "https://example.com", cache_mode: "refresh" });
    expect(text(refreshed)).toContain("alpha-2");
    const bypassed = await tool.execute("bypass", { url: "https://example.com", cache_mode: "bypass" });
    expect(text(bypassed)).toContain("alpha-3");
    const cached = await tool.execute("cached", { url: "https://example.com" });
    expect(text(cached)).toContain("alpha-2");
    expect(calls).toBe(3);
  });

  test("does not cache an anti-bot challenge", async () => {
    let calls = 0;
    const challenge = `<!doctype html><html><head><title>Just a moment</title></head>
      <body><script src="/cdn-cgi/challenge-platform/x"></script>Verify you are human</body></html>`;
    const tool = createFetchUrlTool({
      cache: new LinkContentCache(),
      fetchFn: () => {
        calls += 1;
        return Promise.resolve(new Response(challenge, { headers: { "content-type": "text/html" } }));
      },
    });
    const first = await Promise.allSettled([Promise.resolve(tool.execute("one", { url: "https://example.com" }))]);
    const second = await Promise.allSettled([Promise.resolve(tool.execute("two", { url: "https://example.com" }))]);
    expect(first[0].status === "rejected" ? String(first[0].reason) : "").toContain("anti-bot challenge");
    expect(second[0].status === "rejected" ? String(second[0].reason) : "").toContain("anti-bot challenge");
    expect(calls).toBe(4);
  });

  test("returns image content for an image URL", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const tool = createFetchUrlTool({
      cache: new LinkContentCache(),
      fetchFn: () => Promise.resolve(new Response(png, { headers: { "content-type": "image/png" } })),
    });
    const result = await tool.execute("image", { url: "https://example.com/a.png" });
    expect(result.content.some((part) => part.type === "image")).toBeTrue();
    expect((result.details as { resolvedKind?: string }).resolvedKind).toBe("image");
  });

  test("rejects invalid URLs and incompatible range search", async () => {
    const tool = createFetchUrlTool();
    const results = await Promise.allSettled([
      Promise.resolve(tool.execute("invalid", { url: "not-a-url" })),
      Promise.resolve(tool.execute("mixed", {
        url: "https://example.com",
        pattern: "x",
        start_line: 2,
      })),
    ]);
    expect(results[0].status === "rejected" ? String(results[0].reason) : "").toContain("Invalid URL");
    expect(results[1].status === "rejected" ? String(results[1].reason) : "").toContain("pattern cannot be combined");
  });
});
