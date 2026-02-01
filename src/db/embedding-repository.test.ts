import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createDatabase, type Database } from "./database";
import {
  storeMemoryEmbedding,
  storeMessageEmbedding,
  deleteMemoryEmbedding,
  deleteMessageEmbedding,
  searchMemoryEmbeddings,
  searchMessageEmbeddings,
  hasMemoryEmbedding,
  hasMessageEmbedding,
} from "./embedding-repository";

const DIMS = 1024;

function randomVector(): Float32Array {
  const v = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) v[i] = Math.random() - 0.5;
  return v;
}

function similarVector(base: Float32Array, noise = 0.01): Float32Array {
  const v = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) v[i] = base[i] + (Math.random() - 0.5) * noise;
  return v;
}

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("storeMemoryEmbedding", () => {
  test("inserts embedding and can be found via search", () => {
    const vec = randomVector();
    storeMemoryEmbedding(db, "mem-1", vec);

    const results = searchMemoryEmbeddings(db, vec, 5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("mem-1");
    expect(results[0].distance).toBeCloseTo(0, 1);
  });

  test("overwrites existing embedding on same id", () => {
    const vec1 = randomVector();
    const vec2 = randomVector();
    storeMemoryEmbedding(db, "mem-1", vec1);
    storeMemoryEmbedding(db, "mem-1", vec2);

    const results = searchMemoryEmbeddings(db, vec2, 5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("mem-1");
    expect(results[0].distance).toBeCloseTo(0, 1);
  });
});

describe("storeMessageEmbedding", () => {
  test("inserts embedding and can be found via search", () => {
    const vec = randomVector();
    storeMessageEmbedding(db, "msg-1", vec);

    const results = searchMessageEmbeddings(db, vec, 5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("msg-1");
    expect(results[0].distance).toBeCloseTo(0, 1);
  });
});

describe("deleteMemoryEmbedding", () => {
  test("removes embedding so search returns empty", () => {
    const vec = randomVector();
    storeMemoryEmbedding(db, "mem-1", vec);
    deleteMemoryEmbedding(db, "mem-1");

    const results = searchMemoryEmbeddings(db, vec, 5);
    expect(results.length).toBe(0);
  });

  test("returns false for non-existent id", () => {
    const result = deleteMemoryEmbedding(db, "nonexistent");
    expect(result).toBe(false);
  });
});

describe("deleteMessageEmbedding", () => {
  test("removes embedding", () => {
    const vec = randomVector();
    storeMessageEmbedding(db, "msg-1", vec);
    deleteMessageEmbedding(db, "msg-1");

    const results = searchMessageEmbeddings(db, vec, 5);
    expect(results.length).toBe(0);
  });
});

describe("searchMemoryEmbeddings", () => {
  test("returns closest matches first", () => {
    const target = randomVector();
    const close = similarVector(target, 0.01);
    const far = randomVector();

    storeMemoryEmbedding(db, "close", close);
    storeMemoryEmbedding(db, "far", far);

    const results = searchMemoryEmbeddings(db, target, 5);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe("close");
    expect(results[0].distance).toBeLessThan(results[1].distance);
  });

  test("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      storeMemoryEmbedding(db, `mem-${i}`, randomVector());
    }

    const results = searchMemoryEmbeddings(db, randomVector(), 3);
    expect(results.length).toBe(3);
  });

  test("returns empty for no embeddings", () => {
    const results = searchMemoryEmbeddings(db, randomVector(), 5);
    expect(results.length).toBe(0);
  });
});

describe("searchMessageEmbeddings", () => {
  test("returns closest matches first", () => {
    const target = randomVector();
    const close = similarVector(target, 0.01);
    const far = randomVector();

    storeMessageEmbedding(db, "close", close);
    storeMessageEmbedding(db, "far", far);

    const results = searchMessageEmbeddings(db, target, 5);
    expect(results.length).toBe(2);
    expect(results[0].id).toBe("close");
    expect(results[0].distance).toBeLessThan(results[1].distance);
  });
});

describe("hasMemoryEmbedding", () => {
  test("returns true when embedding exists", () => {
    storeMemoryEmbedding(db, "mem-1", randomVector());
    expect(hasMemoryEmbedding(db, "mem-1")).toBe(true);
  });

  test("returns false when embedding does not exist", () => {
    expect(hasMemoryEmbedding(db, "nonexistent")).toBe(false);
  });
});

describe("hasMessageEmbedding", () => {
  test("returns true when embedding exists", () => {
    storeMessageEmbedding(db, "msg-1", randomVector());
    expect(hasMessageEmbedding(db, "msg-1")).toBe(true);
  });

  test("returns false when embedding does not exist", () => {
    expect(hasMessageEmbedding(db, "nonexistent")).toBe(false);
  });
});
