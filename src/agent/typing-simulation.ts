import type { TypingSimulationConfig } from "../config/types.ts";

export type TypingSimulationPhase = "input" | "output";

/** Counts human-readable word-like tokens for pacing heuristics. */
export function countTextWords(text: string): number {
  return text.match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu)?.length ?? 0;
}

/** Computes a clamped word-scaled typing delay for one simulation phase. */
export function typingSimulationDelayMs(
  config: TypingSimulationConfig,
  phase: TypingSimulationPhase,
  text: string,
): number {
  if (!config.enabled) return 0;
  const words = countTextWords(text);
  if (words === 0) return 0;

  const wordsPerMinute = phase === "input" ? config.inputReadingWpm : config.outputTypingWpm;
  if (wordsPerMinute <= 0) return 0;
  const minMs = phase === "input" ? config.inputMinDelayMs : config.outputMinHoldMs;
  const maxMs = phase === "input" ? config.inputMaxDelayMs : config.outputMaxHoldMs;
  const lower = Math.max(0, minMs);
  const upper = Math.max(lower, maxMs);
  return Math.min(upper, Math.max(lower, (words * 60_000) / wordsPerMinute));
}
