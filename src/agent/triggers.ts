import type { TriggerConfig } from "../config/types.ts";

/** Minimal message data needed for trigger evaluation. */
export interface TriggerInput {
  content: string;
  authorId: string;
  botUserId: string;
  mentionedUserIds: string[];
}

export type TriggerResult =
  | { reason: "mention" }
  | { reason: "keyword"; keyword: string }
  | { reason: "random" }
  | null;

/**
 * Evaluate whether the bot should respond to a message.
 *
 * Priority: mention > keyword > random.
 * Returns null if the bot should not respond.
 *
 * @param rng - Injectable RNG for deterministic testing. Defaults to Math.random.
 */
export function shouldRespond(
  input: TriggerInput,
  triggers: TriggerConfig,
  rng: () => number = Math.random
): TriggerResult {
  // Never respond to self
  if (input.authorId === input.botUserId) return null;

  // 1. Mention
  if (triggers.mention && input.mentionedUserIds.includes(input.botUserId)) {
    return { reason: "mention" };
  }

  // 2. Keyword (word-boundary, case-insensitive)
  if (triggers.keywords.length > 0 && input.content.length > 0) {
    const lower = input.content.toLowerCase();
    for (const kw of triggers.keywords) {
      const pattern = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
      if (pattern.test(lower)) {
        return { reason: "keyword", keyword: kw.toLowerCase() };
      }
    }
  }

  // 3. Random chance
  if (triggers.randomChance > 0 && rng() < triggers.randomChance) {
    return { reason: "random" };
  }

  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
