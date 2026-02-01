import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBEDDING_DIMENSIONS = 1024;
export const DEFAULT_MODEL = "Xenova/bge-m3";

export interface EmbeddingPipeline {
  embed(texts: string[]): Promise<Float32Array[]>;
  dispose(): Promise<void>;
}

export interface PipelineOptions {
  model?: string;
  cacheDir?: string;
  /** Override dtype. Default "q8" (quantized). */
  dtype?: string;
}

let singleton: EmbeddingPipeline | null = null;

/**
 * Create an embedding pipeline backed by @huggingface/transformers.
 * Downloads the model on first use to cacheDir.
 */
export async function createEmbeddingPipeline(options: PipelineOptions = {}): Promise<EmbeddingPipeline> {
  const model = options.model ?? DEFAULT_MODEL;
  const dtype = options.dtype ?? "q8";

  if (options.cacheDir !== undefined && options.cacheDir !== "") {
    env.cacheDir = options.cacheDir;
  }

  // Disable remote model checks after initial download
  env.allowLocalModels = true;

  const extractor: FeatureExtractionPipeline = await pipeline("feature-extraction", model, {
    dtype: dtype as "q8" | "auto" | "fp32" | "fp16",
  });

  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];

      const output = await extractor(texts, { pooling: "cls", normalize: true });
      const data = output.data as Float32Array;
      const results: Float32Array[] = [];

      for (let i = 0; i < texts.length; i++) {
        results.push(data.slice(i * EMBEDDING_DIMENSIONS, (i + 1) * EMBEDDING_DIMENSIONS));
      }

      return results;
    },

    async dispose(): Promise<void> {
      await extractor.dispose();
    },
  };
}

/** Get or create the singleton embedding pipeline. */
export async function getEmbeddingPipeline(options: PipelineOptions = {}): Promise<EmbeddingPipeline> {
  singleton ??= await createEmbeddingPipeline(options);
  return singleton;
}

/** Dispose the singleton (for cleanup). */
export async function disposePipeline(): Promise<void> {
  if (singleton) {
    await singleton.dispose();
    singleton = null;
  }
}
