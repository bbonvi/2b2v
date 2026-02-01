import type { Database } from "./database";

export interface EmbeddingSearchResult {
  id: string;
  distance: number;
}

/** Store or replace a memory embedding in the vec0 table. */
export function storeMemoryEmbedding(db: Database, memoryId: string, embedding: Float32Array): void {
  // Delete first to handle upsert (vec0 doesn't support ON CONFLICT)
  db.raw.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memoryId);
  db.raw.prepare("INSERT INTO memory_embeddings(memory_id, embedding) VALUES (?, ?)").run(memoryId, embedding);
}

/** Store or replace a message embedding in the vec0 table. */
export function storeMessageEmbedding(db: Database, messageId: string, embedding: Float32Array): void {
  db.raw.prepare("DELETE FROM message_embeddings WHERE message_id = ?").run(messageId);
  db.raw.prepare("INSERT INTO message_embeddings(message_id, embedding) VALUES (?, ?)").run(messageId, embedding);
}

/** Delete a memory embedding. Returns true if it existed. */
export function deleteMemoryEmbedding(db: Database, memoryId: string): boolean {
  const result = db.raw.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memoryId);
  return result.changes > 0;
}

/** Delete a message embedding. Returns true if it existed. */
export function deleteMessageEmbedding(db: Database, messageId: string): boolean {
  const result = db.raw.prepare("DELETE FROM message_embeddings WHERE message_id = ?").run(messageId);
  return result.changes > 0;
}

/** KNN search against memory embeddings. Returns ids sorted by distance ascending. */
export function searchMemoryEmbeddings(
  db: Database,
  query: Float32Array,
  limit: number,
): EmbeddingSearchResult[] {
  const rows = db.raw
    .prepare(
      `SELECT memory_id, distance
       FROM memory_embeddings
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`
    )
    .all(query, limit) as Array<{ memory_id: string; distance: number }>;

  return rows.map((r) => ({ id: r.memory_id, distance: r.distance }));
}

/** KNN search against message embeddings. Returns ids sorted by distance ascending. */
export function searchMessageEmbeddings(
  db: Database,
  query: Float32Array,
  limit: number,
): EmbeddingSearchResult[] {
  const rows = db.raw
    .prepare(
      `SELECT message_id, distance
       FROM message_embeddings
       WHERE embedding MATCH ?
       ORDER BY distance
       LIMIT ?`
    )
    .all(query, limit) as Array<{ message_id: string; distance: number }>;

  return rows.map((r) => ({ id: r.message_id, distance: r.distance }));
}

/** Check if a memory embedding exists. */
export function hasMemoryEmbedding(db: Database, memoryId: string): boolean {
  const row = db.raw
    .prepare("SELECT memory_id FROM memory_embeddings WHERE memory_id = ?")
    .get(memoryId);
  return row !== null;
}

/** Check if a message embedding exists. */
export function hasMessageEmbedding(db: Database, messageId: string): boolean {
  const row = db.raw
    .prepare("SELECT message_id FROM message_embeddings WHERE message_id = ?")
    .get(messageId);
  return row !== null;
}
