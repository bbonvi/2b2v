import { test, expect, describe } from "bun:test";
import {
  createBraveSearchTool,
  type BraveSearchToolDeps,
  type BraveSearchResult,
} from "./brave-search-tool";
import type { TextContent } from "@mariozechner/pi-ai";

function makeDeps(results: BraveSearchResult[]): BraveSearchToolDeps {
  return {
    apiKey: "test-key",
    fetchResults: (_query, _count) => Promise.resolve(results),
  };
}

const RESULTS: BraveSearchResult[] = [
  { title: "Bun Runtime", url: "https://bun.sh", description: "A fast JavaScript runtime" },
  { title: "Node.js", url: "https://nodejs.org", description: "JavaScript runtime built on V8" },
];

describe("createBraveSearchTool", () => {
  test("returns web_search AgentTool with correct metadata", () => {
    const tool = createBraveSearchTool(makeDeps(RESULTS));
    expect(tool.label).toBe("web_search");
    expect(tool.description).toBeDefined();
    expect(tool.parameters).toBeDefined();
  });

  test("returns formatted search results", async () => {
    const tool = createBraveSearchTool(makeDeps(RESULTS));
    const result = await tool.execute("tc1", { query: "bun runtime" }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("Bun Runtime");
    expect(text).toContain("https://bun.sh");
    expect(text).toContain("fast JavaScript runtime");
    expect((result.details as { count: number }).count).toBe(2);
  });

  test("passes count parameter to fetchResults", async () => {
    let passedCount: number | undefined;
    const deps: BraveSearchToolDeps = {
      apiKey: "test-key",
      fetchResults: (_query, count) => {
        passedCount = count;
        return Promise.resolve(RESULTS);
      },
    };
    const tool = createBraveSearchTool(deps);
    await tool.execute("tc1", { query: "test", count: 3 }, AbortSignal.timeout(5000));
    expect(passedCount).toBe(3);
  });

  test("defaults count to 5", async () => {
    let passedCount: number | undefined;
    const deps: BraveSearchToolDeps = {
      apiKey: "test-key",
      fetchResults: (_query, count) => {
        passedCount = count;
        return Promise.resolve(RESULTS);
      },
    };
    const tool = createBraveSearchTool(deps);
    await tool.execute("tc1", { query: "test" }, AbortSignal.timeout(5000));
    expect(passedCount).toBe(5);
  });

  test("handles empty results", async () => {
    const tool = createBraveSearchTool(makeDeps([]));
    const result = await tool.execute("tc1", { query: "obscure query" }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("No results");
    expect((result.details as { count: number }).count).toBe(0);
  });

  test("handles fetch errors gracefully", async () => {
    const deps: BraveSearchToolDeps = {
      apiKey: "test-key",
      fetchResults: () => { throw new Error("API rate limit"); },
    };
    const tool = createBraveSearchTool(deps);
    const result = await tool.execute("tc1", { query: "test" }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("Unable to perform");
  });

  test("includes URL and description for each result", async () => {
    const tool = createBraveSearchTool(makeDeps(RESULTS));
    const result = await tool.execute("tc1", { query: "javascript" }, AbortSignal.timeout(5000));
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("Node.js");
    expect(text).toContain("https://nodejs.org");
    expect(text).toContain("JavaScript runtime built on V8");
  });
});
