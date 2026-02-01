/**
 * Split a message into chunks that fit within Discord's character limit.
 *
 * Cascading strategy: line breaks → sentence boundaries → hard cut.
 * Concatenating all returned chunks reconstructs the original text exactly.
 */
export function splitMessage(text: string, limit: number = 2000): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    const cutIndex = findSplitPoint(remaining, limit);
    chunks.push(remaining.slice(0, cutIndex));
    remaining = remaining.slice(cutIndex);
  }

  return chunks;
}

/** Find the best index to cut at within `text[0..limit]`. */
function findSplitPoint(text: string, limit: number): number {
  // 1. Try splitting at a newline boundary
  const segment = text.slice(0, limit);
  const lastNewline = segment.lastIndexOf("\n");
  if (lastNewline !== -1) {
    return lastNewline + 1; // include the \n in the current chunk
  }

  // 2. Try splitting at a sentence boundary
  const sentenceEnd = findLastSentenceBoundary(segment);
  if (sentenceEnd !== -1) {
    return sentenceEnd;
  }

  // 3. Hard cut at limit
  return limit;
}

/** Find last sentence boundary (`. `, `! `, `? `, `.\n`) within text. */
function findLastSentenceBoundary(text: string): number {
  let best = -1;
  for (let i = 1; i < text.length; i++) {
    const ch = text[i - 1];
    if (ch === "." || ch === "!" || ch === "?") {
      const next = text[i];
      if (next === " " || next === "\n") {
        // Split after the punctuation + delimiter
        best = i + 1;
      }
    }
  }
  return best;
}
