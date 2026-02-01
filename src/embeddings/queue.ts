import type { QdrantClient } from "@qdrant/js-client-rest";
import type { EmbeddingPipeline } from "./pipeline";
import { upsertPoints, type PointPayload } from "../qdrant/adapter";

export type EmbeddingTarget = "memory" | "message";

export interface EmbedRequestMetadata {
  guild_id?: string;
  channel_id?: string;
  user_id?: string;
  created_at?: number;
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

  let queue: PendingItem[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let processing = false;
  let closed = false;

  async function processBatch(batch: PendingItem[]): Promise<void> {
    try {
      const texts = batch.map((item) => item.text);
      const embeddings = await pipeline.embed(texts);

      const points = batch.map((item, i) => {
        const payload: PointPayload = {
          type: item.target,
          entity_id: item.id,
          guild_id: item.metadata?.guild_id,
          channel_id: item.metadata?.channel_id,
          user_id: item.metadata?.user_id,
          message_id: item.target === "message" ? item.id : undefined,
          created_at: item.metadata?.created_at,
        };
        return {
          id: item.id,
          vector: Array.from(embeddings[i]),
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
      drain();
    }, flushDelayMs);
  }

  return {
    enqueue(request: EmbedRequest): Promise<void> {
      if (closed) return Promise.reject(new Error("Queue is shut down"));

      return new Promise<void>((resolve, reject) => {
        queue.push({ ...request, resolve, reject });

        if (queue.length >= batchSize) {
          if (flushTimer !== null) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          drain();
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
