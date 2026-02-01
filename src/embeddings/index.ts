export {
  createEmbeddingPipeline,
  getEmbeddingPipeline,
  disposePipeline,
  EMBEDDING_DIMENSIONS,
  DEFAULT_MODEL,
  type EmbeddingPipeline,
  type PipelineOptions,
} from "./pipeline";

export {
  createEmbeddingQueue,
  type EmbeddingQueue,
  type EmbeddingQueueOptions,
  type EmbedRequest,
  type EmbedRequestMetadata,
  type EmbeddingTarget,
} from "./queue";
