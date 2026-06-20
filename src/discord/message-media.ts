import type { ImageSourceKind } from "../db/image-repository.ts";

export interface StickerLike {
  name: string;
  url?: string | null;
  format?: number | string | null;
}

export interface EmbedLike {
  type?: string | null;
  url?: string | null;
  provider?: { name?: string | null } | null;
}

const GIF_PROVIDER_NAMES = new Set(["giphy", "tenor"]);
const IMAGE_URL_EXTENSIONS = /\.(?:avif|gif|jpe?g|png|tiff?|webp)(?:[?#]|$)/i;
const GIF_URL_EXTENSION = /\.gif(?:[?#]|$)/i;

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

/** Classify a Discord attachment image for prompt history metadata. */
export function imageKindForAttachment(contentType: string | null | undefined, nameOrUrl?: string | null): ImageSourceKind {
  if ((contentType ?? "").toLowerCase().startsWith("image/gif")) return "gif";
  if (nameOrUrl !== undefined && nameOrUrl !== null && GIF_URL_EXTENSION.test(nameOrUrl)) return "gif";
  return "image";
}

/** True when an embed looks like a GIF service preview even if the preview URL is static WebP/PNG. */
export function isGifLikeEmbed(embed: EmbedLike): boolean {
  if (embed.type === "gifv") return true;
  const providerName = embed.provider?.name?.toLowerCase();
  if (providerName !== undefined && GIF_PROVIDER_NAMES.has(providerName)) return true;
  return embed.url !== undefined && embed.url !== null && GIF_URL_EXTENSION.test(embed.url);
}

/** Classify an embed preview image for prompt history metadata. */
export function imageKindForEmbed(embed: EmbedLike, imageUrl: string): ImageSourceKind {
  return isGifLikeEmbed(embed) || GIF_URL_EXTENSION.test(imageUrl) ? "gif" : "image";
}

/** Guess the MIME type needed for the ingest pipeline from a Discord media URL. */
export function guessImageMimeFromUrl(url: string): string {
  if (/\.gif(?:[?#]|$)/i.test(url)) return "image/gif";
  if (/\.webp(?:[?#]|$)/i.test(url)) return "image/webp";
  if (/\.avif(?:[?#]|$)/i.test(url)) return "image/avif";
  if (/\.jpe?g(?:[?#]|$)/i.test(url)) return "image/jpeg";
  return "image/png";
}

/** Return a fetchable sticker image preview when Discord exposes one and the format is image-like. */
export function stickerImagePreview(sticker: StickerLike): { url: string; mimeType: string; sourceKind: ImageSourceKind } | null {
  if (sticker.url === undefined || sticker.url === null || sticker.url === "") return null;
  const format = String(sticker.format ?? "").toLowerCase();
  if (format === "3" || format === "lottie") return null;
  if (!IMAGE_URL_EXTENSIONS.test(sticker.url)) return null;
  const mimeType = guessImageMimeFromUrl(sticker.url);
  return {
    url: sticker.url,
    mimeType,
    sourceKind: "sticker",
  };
}
