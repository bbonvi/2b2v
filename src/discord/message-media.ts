export interface StickerLike {
  name: string;
}

/** Build the prompt-visible sticker tags appended to message history content. */
export function stickerTags(stickers: Iterable<StickerLike>): string {
  return [...stickers]
    .map((sticker) => sticker.name.replace(/[\t\n\r<>]+/g, " ").trim())
    .filter((name) => name !== "")
    .map((name) => `<sticker>${name}</sticker>`)
    .join(" ");
}

/** Append sticker tags without dropping the original message text or URL content. */
export function appendStickerTags(content: string, stickers: Iterable<StickerLike>): string {
  const tags = stickerTags(stickers);
  if (tags === "") return content;
  return content.trim() === "" ? tags : `${content} ${tags}`;
}
