export { createDatabase, type Database } from "./database";

export {
  createMemory,
  updateMemory,
  deleteMemory,
  getMemory,
  listMemories,
  deleteExpiredMemories,
  type MemoryScope,
  type MemoryRow,
  type CreateMemoryInput,
  type UpdateMemoryInput,
  type ListMemoriesFilter,
} from "./memory-repository";

export {
  storeMemoryEmbedding,
  storeMessageEmbedding,
  deleteMemoryEmbedding,
  deleteMessageEmbedding,
  searchMemoryEmbeddings,
  searchMessageEmbeddings,
  hasMemoryEmbedding,
  hasMessageEmbedding,
  type EmbeddingSearchResult,
} from "./embedding-repository";
