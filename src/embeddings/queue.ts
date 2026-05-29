import type { QdrantClient } from "@qdrant/js-client-rest";
import type { EmbeddingPipeline } from "./pipeline";
import { upsertPoints, type PointPayload } from "../qdrant/adapter";
import { normalizeMessageForEmbedding } from "./message-text.ts";

export type EmbeddingTarget = "memory" | "message";

export interface EmbedRequestMetadata {
  guild_id?: string;
  channel_id?: string;
  user_id?: string;
  created_at?: number;
  last_created_at?: number;
  message_id?: string;
  message_ids?: string[];
  first_message_id?: string;
  last_message_id?: string;
  message_count?: number;
  is_bot?: boolean;
  source?: "live" | "backfill" | "reindex" | "memory";
  embedding_kind?: "single" | "merged";
}

export interface EmbedRequest {
  id: string;
  text: string;
  target: EmbeddingTarget;
  metadata?: EmbedRequestMetadata;
}

interface PendingItem extends EmbedRequest {
  resolve: () => void;
  reject: (err: Error) => void;
}

export interface EmbeddingQueueOptions {
  /** Max items per batch. Default 32. */
  batchSize?: number;
  /** Delay in ms before flushing a partial batch. Default 100. */
  flushDelayMs?: number;
}

export interface EmbeddingQueue {
  /** Enqueue a text for embedding. Resolves when stored in Qdrant. */
  enqueue(request: EmbedRequest): Promise<void>;
  /** Enqueue multiple items. Resolves when all are stored. */
  enqueueBatch(requests: EmbedRequest[]): Promise<void>;
  /** Flush any pending items immediately. */
  flush(): Promise<void>;
  /** Number of items waiting to be processed. */
  pending(): number;
  /** Shut down: flush remaining and prevent new enqueues. */
  shutdown(): Promise<void>;
}

export function createEmbeddingQueue(
  pipeline: EmbeddingPipeline,
  qdrant: QdrantClient,
  options: EmbeddingQueueOptions = {},
): EmbeddingQueue {
  const batchSize = options.batchSize ?? 32;
  const flushDelayMs = options.flushDelayMs ?? 100;

  const queue: PendingItem[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let processing = false;
  let closed = false;

  async function processBatch(batch: PendingItem[]): Promise<void> {
    try {
      const texts = batch.map((item) => item.target === "message" ? normalizeMessageForEmbedding(item.text) : item.text.trim());
      const embeddings = await pipeline.embed(texts);

      const points = batch.map((item, i) => {
        const messageId = item.metadata?.message_id ?? (item.target === "message" ? item.id : undefined);
        const messageIds = item.metadata?.message_ids ?? (messageId !== undefined ? [messageId] : undefined);
        const messageCount = item.metadata?.message_count ?? messageIds?.length;
        const payload: PointPayload = {
          type: item.target,
          entity_id: item.id,
          guild_id: item.metadata?.guild_id,
          channel_id: item.metadata?.channel_id,
          user_id: item.metadata?.user_id,
          message_id: messageId,
          message_ids: messageIds,
          first_message_id: item.metadata?.first_message_id ?? messageIds?.[0],
          last_message_id: item.metadata?.last_message_id ?? messageIds?.[messageIds.length - 1],
          message_count: messageCount,
          created_at: item.metadata?.created_at,
          last_created_at: item.metadata?.last_created_at ?? item.metadata?.created_at,
          is_bot: item.metadata?.is_bot,
          source: item.metadata?.source,
          embedding_kind: item.metadata?.embedding_kind ?? (messageCount !== undefined && messageCount > 1 ? "merged" : "single"),
        };
        return {
          id: item.id,
          vector: Array.from(embeddings[i] ?? new Float32Array(0)),
          payload,
        };
      });

      await upsertPoints(qdrant, points);

      for (const item of batch) {
        item.resolve();
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      for (const item of batch) {
        item.reject(error);
      }
    }
  }

  async function drain(): Promise<void> {
    if (processing || queue.length === 0) return;
    processing = true;

    while (queue.length > 0) {
      const batch = queue.splice(0, batchSize);
      await processBatch(batch);
    }

    processing = false;
  }

  function scheduleFlush(): void {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void drain();
    }, flushDelayMs);
  }

  return {
    enqueue(request: EmbedRequest): Promise<void> {
      if (closed) return Promise.reject(new Error("Queue is shut down"));
      const normalizedText = request.target === "message" ? normalizeMessageForEmbedding(request.text) : request.text.trim();
      if (normalizedText === "") return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        queue.push({ ...request, text: normalizedText, resolve, reject });

        if (queue.length >= batchSize) {
          if (flushTimer !== null) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          void drain();
        } else {
          scheduleFlush();
        }
      });
    },

    async enqueueBatch(requests: EmbedRequest[]): Promise<void> {
      await Promise.all(requests.map((r) => this.enqueue(r)));
    },

    async flush(): Promise<void> {
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      await drain();
    },

    pending(): number {
      return queue.length;
    },

    async shutdown(): Promise<void> {
      closed = true;
      await this.flush();
    },
  };
}
