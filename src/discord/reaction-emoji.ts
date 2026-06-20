export interface ReactionEmojiInfo {
  id: string;
  animated: boolean;
}

export type ReactionEmojiLookup = (name: string) => ReactionEmojiInfo | undefined;

const CUSTOM_EMOJI_MARKUP = /^<a?:[A-Za-z0-9_]+:\d+>$/;
const COLON_NAME = /^:([A-Za-z0-9_]+):$/;
const PLAIN_CUSTOM_NAME = /^[A-Za-z0-9_]+$/;

/** Resolve user-facing emoji input into a Discord reaction identifier. */
export function resolveReactionEmojiInput(
  rawEmoji: string,
  lookupCustomEmoji: ReactionEmojiLookup,
): string | null {
  const trimmed = rawEmoji.trim();
  if (trimmed === "") return null;
  if (CUSTOM_EMOJI_MARKUP.test(trimmed)) return trimmed;

  const colonMatch = COLON_NAME.exec(trimmed);
  const customName = colonMatch?.[1] ?? (PLAIN_CUSTOM_NAME.test(trimmed) ? trimmed : undefined);
  if (customName !== undefined) {
    const customEmoji = lookupCustomEmoji(customName);
    if (customEmoji !== undefined) {
      return customEmoji.animated
        ? `<a:${customName}:${customEmoji.id}>`
        : `<:${customName}:${customEmoji.id}>`;
    }
  }

  return trimmed;
}
