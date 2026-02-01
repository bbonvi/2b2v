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
    expect(results[0].length).toBe(EMBEDDING_DIMENSIONS);
  });

  test("embeddings are L2 normalized", async () => {
    const pipe = createMockPipeline();
    const results = await pipe.embed(["normalize me"]);
    let norm = 0;
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) norm += results[0][i] * results[0][i];
    expect(Math.sqrt(norm)).toBeCloseTo(1.0, 4);
  });

  test("empty input returns empty array", async () => {
    const pipe = createMockPipeline();
    const results = await pipe.embed([]);
    expect(results).toEqual([]);
  });

  test("same text produces same embedding", async () => {
    const pipe = createMockPipeline();
    const [a] = await pipe.embed(["deterministic"]);
    const [b] = await pipe.embed(["deterministic"]);
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      expect(a[i]).toBe(b[i]);
    }
  });

  test("different texts produce different embeddings", async () => {
    const pipe = createMockPipeline();
    const [a, b] = await pipe.embed(["hello", "completely different text"]);
    let same = true;
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      if (a[i] !== b[i]) { same = false; break; }
    }
    expect(same).toBe(false);
  });
});

