import type { QdrantClient } from "@qdrant/js-client-rest";
import { COLLECTION_NAME } from "./client";

/** Payload stored alongside each vector point in Qdrant. */
export interface PointPayload {
  /** Discriminator for memory vs message embeddings. */
  type: "memory" | "message";
  /** Original entity ID (Discord message snowflake or memory UUID). */
  entity_id: string;
  guild_id?: string;
  channel_id?: string;
  user_id?: string;
  message_id?: string;
  created_at?: number;
}

/**
 * Convert an entity ID to a deterministic UUID for Qdrant point IDs.
 * Qdrant requires UUIDs or unsigned integers — Discord snowflakes are neither.
 */
export function toPointId(entityId: string): string {
  const hash = new Uint8Array(16);
  for (let i = 0; i < entityId.length; i++) {
    const idx = i % 16;
    const cur = hash[idx] ?? 0;
    hash[idx] = (cur ^ entityId.charCodeAt(i));
    hash[idx] = ((hash[idx] ?? 0) * 31 + entityId.charCodeAt(i)) & 0xff;
  }
  // Set UUID v4 version and variant bits
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x40;
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface SearchFilter {
  guild_id: string;
  channel_id?: string;
  user_id?: string;
  after?: number;
  before?: number;
}

export interface SearchResult {
  /** Original entity ID from payload. */
  id: string;
  score: number;
  payload: PointPayload;
}

/**
 * Upsert a single vector point with metadata payload.
 * Accepts entity ID as string; converts to UUID internally.
 */
export async function upsertPoint(
  client: QdrantClient,
  entityId: string,
  vector: number[],
  payload: PointPayload,
): Promise<void> {
  await client.upsert(COLLECTION_NAME, {
    wait: true,
    points: [{ id: toPointId(entityId), vector, payload: { ...payload, entity_id: entityId } }],
  });
}

/**
 * Upsert multiple vector points in a single batch.
 */
export async function upsertPoints(
  client: QdrantClient,
  points: Array<{ id: string; vector: number[]; payload: PointPayload }>,
): Promise<void> {
  if (points.length === 0) return;
  await client.upsert(COLLECTION_NAME, {
    wait: true,
    points: points.map((p) => ({
      id: toPointId(p.id),
      vector: p.vector,
      payload: { ...p.payload, entity_id: p.id },
    })),
  });
}

/**
 * Delete a point by entity ID. Returns silently if point does not exist.
 */
export async function deletePoint(
  client: QdrantClient,
  entityId: string,
): Promise<void> {
  await client.delete(COLLECTION_NAME, {
    wait: true,
    points: [toPointId(entityId)],
  });
}

/**
 * Check if a point exists by entity ID.
 */
export async function pointExists(
  client: QdrantClient,
  entityId: string,
): Promise<boolean> {
  const results = await client.retrieve(COLLECTION_NAME, {
    ids: [toPointId(entityId)],
    with_payload: false,
    with_vector: false,
  });
  return results.length > 0;
}

/**
 * Search for similar vectors with metadata filtering.
 * guild_id is always required. Additional filters are optional.
 */
export async function searchPoints(
  client: QdrantClient,
  vector: number[],
  filter: SearchFilter,
  options: { type?: "memory" | "message"; limit?: number } = {},
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10;

  const must: Array<Record<string, unknown>> = [
    { key: "guild_id", match: { value: filter.guild_id } },
  ];

  if (options.type !== undefined) {
    must.push({ key: "type", match: { value: options.type } });
  }
  if (filter.channel_id !== undefined && filter.channel_id !== "") {
    must.push({ key: "channel_id", match: { value: filter.channel_id } });
  }
  if (filter.user_id !== undefined && filter.user_id !== "") {
    must.push({ key: "user_id", match: { value: filter.user_id } });
  }
  if (filter.after !== undefined || filter.before !== undefined) {
    const range: Record<string, number> = {};
    if (filter.after !== undefined) range.gt = filter.after;
    if (filter.before !== undefined) range.lt = filter.before;
    must.push({ key: "created_at", range });
  }

  const results = await client.search(COLLECTION_NAME, {
    vector,
    filter: { must },
    limit,
    with_payload: true,
    with_vector: false,
  });

  return results.map((r) => ({
    id: ((r.payload as Record<string, unknown>).entity_id as string | undefined) ?? (r.id as string),
    score: r.score,
    payload: r.payload as unknown as PointPayload,
  }));
}
