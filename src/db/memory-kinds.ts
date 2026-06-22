export const MEMORY_KINDS = [
  "global_note",
  "user_note",
  "preference",
  "relationship",
  "fact",
  "identity",
  "constraint",
  "interest",
  "scratchpad",
] as const;

export type MemoryKind = typeof MEMORY_KINDS[number];

const MEMORY_KIND_SET = new Set<string>(MEMORY_KINDS);

/** SQL literal list for every currently accepted structured memory kind. */
export const MEMORY_KIND_SQL_VALUES = MEMORY_KINDS.map((kind) => `'${kind}'`).join(", ");

/** Return true when a value is one of the persisted structured memory kinds. */
export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && MEMORY_KIND_SET.has(value);
}
