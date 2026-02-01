import type { Database } from "../db/database";
import type { EmbeddingPipeline } from "./pipeline";
import { storeMemoryEmbedding, storeMessageEmbedding } from "../db/embedding-repository";

export type EmbeddingTarget = "memory" | "message";

export interface EmbedRequest {
  id: string;
  text: string;
  target: EmbeddingTarget;
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
  /** Enqueue a text for embedding. Resolves when stored in DB. */
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
  db: Database,
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

      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        const embedding = embeddings[i];

        if (item.target === "memory") {
          storeMemoryEmbedding(db, item.id, embedding);
        } else {
          storeMessageEmbedding(db, item.id, embedding);
        }

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
