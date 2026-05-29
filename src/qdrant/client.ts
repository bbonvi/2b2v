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

async function ensurePayloadIndex(client: QdrantClient, fieldName: string, fieldSchema: "keyword" | "integer" | "bool"): Promise<void> {
  try {
    await client.createPayloadIndex(COLLECTION_NAME, {
      field_name: fieldName,
      field_schema: fieldSchema,
      wait: true,
    });
  } catch {
    // Qdrant returns an error when the index already exists; existing indexes are fine.
  }
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

  }

  await Promise.all([
    ensurePayloadIndex(client, "guild_id", "keyword"),
    ensurePayloadIndex(client, "channel_id", "keyword"),
    ensurePayloadIndex(client, "user_id", "keyword"),
    ensurePayloadIndex(client, "created_at", "integer"),
    ensurePayloadIndex(client, "last_created_at", "integer"),
    ensurePayloadIndex(client, "type", "keyword"),
    ensurePayloadIndex(client, "source", "keyword"),
    ensurePayloadIndex(client, "embedding_kind", "keyword"),
    ensurePayloadIndex(client, "is_bot", "bool"),
  ]);
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
