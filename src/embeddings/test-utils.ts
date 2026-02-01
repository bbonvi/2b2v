import { EMBEDDING_DIMENSIONS, type EmbeddingPipeline } from "./pipeline";

/** In-memory mock pipeline for unit tests (no model download). */
export function createMockPipeline(): EmbeddingPipeline {
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      return texts.map((text) => {
        const vec = new Float32Array(EMBEDDING_DIMENSIONS);
        for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
          vec[i] = Math.sin(text.charCodeAt(i % text.length) * (i + 1) * 0.001);
        }
        let norm = 0;
        for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) norm += vec[i] * vec[i];
        norm = Math.sqrt(norm);
        if (norm > 0) for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) vec[i] /= norm;
        return vec;
      });
    },
    async dispose() {},
  };
}
