import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { QdrantClient } from "@qdrant/js-client-rest";
import {
  createQdrantClient,
  ensureCollection,
  healthCheck,
  COLLECTION_NAME,
} from "./client";
import { EMBEDDING_DIMENSIONS } from "../embeddings/pipeline";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://qdrant-test.orb.local:6333";

let client: QdrantClient;

beforeAll(async () => {
  client = createQdrantClient({ url: QDRANT_URL });
  // Clean slate for tests
  try {
    await client.deleteCollection(COLLECTION_NAME);
  } catch {
    // collection may not exist
  }
});

afterAll(async () => {
  try {
    await client.deleteCollection(COLLECTION_NAME);
  } catch {
    // ignore
  }
});

describe("createQdrantClient", () => {
  test("returns a QdrantClient instance", () => {
    const c = createQdrantClient({ url: QDRANT_URL });
    expect(c).toBeInstanceOf(QdrantClient);
  });
});

describe("healthCheck", () => {
  test("returns true when Qdrant is reachable", async () => {
    const result = await healthCheck(client);
    expect(result).toBe(true);
  });

  test("returns false when Qdrant is unreachable", async () => {
    const bad = createQdrantClient({ url: "http://localhost:19999" });
    const result = await healthCheck(bad);
    expect(result).toBe(false);
  });
});

describe("ensureCollection", () => {
  test("creates collection with correct vector config", async () => {
    await ensureCollection(client);

    const info = await client.getCollection(COLLECTION_NAME);
    const vectorConfig = info.config.params.vectors;

    // Single (unnamed) vector config
    expect(vectorConfig).toMatchObject({
      size: EMBEDDING_DIMENSIONS,
      distance: "Cosine",
    });
  });

  test("creates payload indexes for metadata fields", async () => {
    const info = await client.getCollection(COLLECTION_NAME);
    const indexed = Object.keys(info.payload_schema);

    expect(indexed).toContain("guild_id");
    expect(indexed).toContain("channel_id");
    expect(indexed).toContain("user_id");
    expect(indexed).toContain("created_at");
    expect(indexed).toContain("type");
  });

  test("is idempotent — second call does not error", async () => {
    await ensureCollection(client);
    // Should not throw
    const info = await client.getCollection(COLLECTION_NAME);
    expect(info.config.params.vectors).toMatchObject({
      size: EMBEDDING_DIMENSIONS,
    });
  });
});
