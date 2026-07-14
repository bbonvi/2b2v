import type { TriggerConfig } from "../config/types.ts";

/** Minimal message data needed for trigger evaluation. */
export interface TriggerInput {
  content: string;
  authorId: string;
  /** Whether Discord identifies the author as an automated bot account. */
  authorIsBot?: boolean;
  botUserId: string;
  mentionedUserIds: string[];
  /** Whether this Discord message directly replies to one of the bot's visible messages. */
  repliedToBot?: boolean;
}

export type TriggerResult =
  | { reason: "mention" }
  | { reason: "keyword"; keyword: string }
  | { reason: "random" }
  | { reason: "scheduled" }
  | { reason: "ambient_pickup" }
  | { reason: "lingering_attention" }
  | { reason: "follow_up" }
  | { reason: "ambient_initiative" }
  | null;

/**
 * Evaluate whether the bot should respond to a message.
 *
 * Priority: mention > keyword > random. Automated bot authors are eligible
 * for deliberate mention/keyword triggers, but never random replies.
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
  if (triggers.mention && (input.mentionedUserIds.includes(input.botUserId) || input.repliedToBot === true)) {
    return { reason: "mention" };
  }

  // 2. Keyword (word-boundary, case-insensitive)
  // Uses Unicode property escapes for proper word boundary detection across all scripts
  // (Cyrillic, Japanese, etc.) — \b only works with ASCII [a-zA-Z0-9_]
  if (triggers.keywords.length > 0 && input.content.length > 0) {
    for (const kw of triggers.keywords) {
      const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}])${escapeRegex(kw)}(?![\\p{L}\\p{N}])`,
        "iu"
      );
      if (pattern.test(input.content)) {
        return { reason: "keyword", keyword: kw.toLowerCase() };
      }
    }
  }

  if (input.authorIsBot === true) return null;

  // 3. Random chance
  if (triggers.randomChance > 0 && rng() < triggers.randomChance) {
    return { reason: "random" };
  }

  return null;
}

/** Escape literal text before interpolating it into a regular expression. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
