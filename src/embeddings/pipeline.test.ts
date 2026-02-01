import { test, expect, describe } from "bun:test";
import { EMBEDDING_DIMENSIONS } from "./pipeline";
import { createMockPipeline } from "./test-utils";

describe("EmbeddingPipeline interface", () => {
  test("returns correct number of embeddings", async () => {
    const pipe = createMockPipeline();
    const results = await pipe.embed(["hello", "world", "test"]);
    expect(results.length).toBe(3);
  });

  test("each embedding has correct dimensions", async () => {
    const pipe = createMockPipeline();
    const results = await pipe.embed(["hello"]);
    const first = results[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("unreachable");
    expect(first.length).toBe(EMBEDDING_DIMENSIONS);
  });

  test("embeddings are L2 normalized", async () => {
    const pipe = createMockPipeline();
    const results = await pipe.embed(["normalize me"]);
    const first = results[0];
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("unreachable");
    let norm = 0;
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) { const v = first[i] ?? 0; norm += v * v; }
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 4);
  });

  test("empty input returns empty array", async () => {
    const pipe = createMockPipeline();
    const results = await pipe.embed([]);
    expect(results).toEqual([]);
  });

  test("same text produces same embedding", async () => {
    const pipe = createMockPipeline();
    const resA = await pipe.embed(["deterministic"]);
    const resB = await pipe.embed(["deterministic"]);
    const a = resA[0];
    const b = resB[0];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a === undefined || b === undefined) throw new Error("unreachable");
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      expect(a[i]).toBe(b[i]);
    }
  });

  test("different texts produce different embeddings", async () => {
    const pipe = createMockPipeline();
    const res = await pipe.embed(["hello", "completely different text"]);
    const a = res[0];
    const b = res[1];
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a === undefined || b === undefined) throw new Error("unreachable");
    let same = true;
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      if (a[i] !== b[i]) { same = false; break; }
    }
    expect(same).toBe(false);
  });
});

