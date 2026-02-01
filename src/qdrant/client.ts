import { QdrantClient } from "@qdrant/js-client-rest";
import { EMBEDDING_DIMENSIONS } from "../embeddings/pipeline";

export const COLLECTION_NAME = "embeddings";

export interface QdrantConfig {
  url: string;
}

/**
 * Create a Qdrant client instance.
 * Does not verify connectivity — call ensureCollection or healthCheck for that.
 */
export function createQdrantClient(config: QdrantConfig): QdrantClient {
  return new QdrantClient({ url: config.url, checkCompatibility: false });
}

/**
 * Ensure the embeddings collection exists with correct schema.
 * Creates collection + payload indexes if missing; no-ops if already present.
 */
export async function ensureCollection(client: QdrantClient): Promise<void> {
  const { exists } = await client.collectionExists(COLLECTION_NAME);

  if (!exists) {
    await client.createCollection(COLLECTION_NAME, {
      vectors: {
        size: EMBEDDING_DIMENSIONS,
        distance: "Cosine",
      },
    });

    await Promise.all([
      client.createPayloadIndex(COLLECTION_NAME, {
        field_name: "guild_id",
        field_schema: "keyword",
        wait: true,
      }),
      client.createPayloadIndex(COLLECTION_NAME, {
        field_name: "channel_id",
        field_schema: "keyword",
        wait: true,
      }),
      client.createPayloadIndex(COLLECTION_NAME, {
        field_name: "user_id",
        field_schema: "keyword",
        wait: true,
      }),
      client.createPayloadIndex(COLLECTION_NAME, {
        field_name: "created_at",
        field_schema: "integer",
        wait: true,
      }),
      client.createPayloadIndex(COLLECTION_NAME, {
        field_name: "type",
        field_schema: "keyword",
        wait: true,
      }),
    ]);
  }
}

/**
 * Check Qdrant health/readiness. Returns true if reachable, false otherwise.
 */
export async function healthCheck(client: QdrantClient): Promise<boolean> {
  try {
    await client.versionInfo();
    return true;
  } catch {
    return false;
  }
}
