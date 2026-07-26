import { StickerFormatType, type Message } from "discord.js";
import type { AssetKind, UpsertMessageAsset } from "../db/asset-repository.ts";

const TEXT_EXTENSIONS = /\.(?:c|cc|conf|cpp|css|csv|eml|go|h|hpp|htm|html|ini|java|js|json|jsx|log|md|py|rb|rs|sh|sql|svg|toml|ts|tsx|txt|xml|yaml|yml)$/i;
const PNG_STICKER_FORMAT: number = StickerFormatType.PNG;
const APNG_STICKER_FORMAT: number = StickerFormatType.APNG;
const GIF_STICKER_FORMAT: number = StickerFormatType.GIF;

export interface DiscordMessageAssetData {
  id: string;
  guildId: string;
  channelId: string;
  createdAt: number;
  content: string;
  attachments: Iterable<{
    id: string;
    filename: string;
    contentType?: string | null;
    size: number;
    width?: number | null;
    height?: number | null;
    durationSeconds?: number | null;
  }>;
  embeds: Iterable<{
    type?: string;
    url?: string | null;
    title?: string | null;
    providerName?: string | null;
    video?: { url?: string; width?: number | null; height?: number | null } | null;
    image?: { url?: string; width?: number | null; height?: number | null } | null;
    thumbnail?: { url?: string; width?: number | null; height?: number | null } | null;
  }>;
  stickers: Iterable<{
    id: string;
    name: string;
    formatType: number;
  }>;
}

/** Classify a message asset for history presentation and lazy reader dispatch. */
export function classifyAsset(contentType: string | null | undefined, filename: string | null | undefined, gifLike = false): AssetKind {
  const mime = (contentType ?? "").toLowerCase();
  const name = filename ?? "";
  if (gifLike || mime === "image/gif" || /\.gif(?:$|[?#])/i.test(name)) return "gif";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json") || mime.endsWith("+xml") || mime === "application/xml" || mime === "message/rfc822" || TEXT_EXTENSIONS.test(name)) return "text";
  return "file";
}

/** Convert serializable Discord message data into metadata-only asset rows. */
export function assetsFromDiscordMessageData(message: DiscordMessageAssetData): UpsertMessageAsset[] {
  const base = {
    messageId: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    createdAt: message.createdAt,
  };
  const embeds = [...message.embeds];
  const assets: UpsertMessageAsset[] = [];
  for (const attachment of message.attachments) {
    assets.push({
      ...base,
      sourceKind: "attachment",
      sourceKey: attachment.id,
      kind: classifyAsset(attachment.contentType, attachment.filename),
      filename: attachment.filename,
      contentType: attachment.contentType ?? null,
      size: attachment.size,
      width: attachment.width ?? null,
      height: attachment.height ?? null,
      durationSeconds: attachment.durationSeconds ?? null,
    });
  }
  let embedIndex = 0;
  for (const embed of embeds) {
    const url = embed.video?.url ?? embed.image?.url ?? embed.thumbnail?.url;
    if (url !== undefined) {
      const provider = embed.providerName?.toLowerCase();
      const gifLike = embed.type === "gifv" || provider === "tenor" || provider === "giphy";
      const kind: AssetKind = gifLike
        ? "gif"
        : embed.video !== null && embed.video !== undefined
          ? "video"
          : embed.image !== null && embed.image !== undefined || embed.thumbnail !== null && embed.thumbnail !== undefined
            ? "image"
            : classifyAsset(null, embed.url ?? url);
      assets.push({
        ...base,
        sourceKind: "embed",
        sourceKey: String(embedIndex),
        kind,
        filename: embed.title ?? null,
        contentType: embed.video !== null && embed.video !== undefined ? "video/mp4" : null,
        size: null,
        width: embed.video?.width ?? embed.image?.width ?? embed.thumbnail?.width ?? null,
        height: embed.video?.height ?? embed.image?.height ?? embed.thumbnail?.height ?? null,
        durationSeconds: null,
      });
    }
    embedIndex++;
  }
  for (const sticker of message.stickers) {
    const formatType = sticker.formatType;
    const kind: AssetKind = formatType === GIF_STICKER_FORMAT || formatType === APNG_STICKER_FORMAT
      ? "gif"
      : formatType === PNG_STICKER_FORMAT ? "image" : "file";
    assets.push({
      ...base,
      sourceKind: "sticker",
      sourceKey: sticker.id,
      kind,
      filename: sticker.name,
      contentType: null,
      size: null,
      width: null,
      height: null,
      durationSeconds: null,
    });
  }
  const mediaTargets = new Set<string>();
  for (const embed of embeds) {
    if (embed.url === null || embed.url === undefined) continue;
    if (embed.type === "image" || embed.type === "gifv" || embed.type === "video") {
      const normalized = normalizeHttpUrl(embed.url);
      if (normalized !== null) mediaTargets.add(normalized);
    }
  }
  for (const url of extractMessageUrls(message.content)) {
    if (mediaTargets.has(url)) continue;
    assets.push({
      ...base,
      sourceKind: "url",
      sourceKey: url,
      kind: "link",
      filename: null,
      contentType: null,
      size: null,
      width: null,
      height: null,
      durationSeconds: null,
    });
  }
  return assets;
}

/** Convert a live Discord message's uploads, embeds, and stickers into metadata-only asset rows. */
export function assetsFromDiscordMessage(message: Message): UpsertMessageAsset[] {
  if (message.guildId === null) return [];
  return assetsFromDiscordMessageData({
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    createdAt: message.createdTimestamp,
    content: message.content,
    attachments: [...message.attachments.values()].map((attachment) => ({
      id: attachment.id,
      filename: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
      durationSeconds: attachment.duration,
    })),
    embeds: message.embeds.map((embed) => ({
      type: String(embed.data.type),
      url: embed.url,
      title: embed.title,
      providerName: embed.provider?.name,
      video: embed.video,
      image: embed.image,
      thumbnail: embed.thumbnail,
    })),
    stickers: [...message.stickers.values()].map((sticker) => ({
      id: sticker.id,
      name: sticker.name,
      formatType: sticker.format,
    })),
  });
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;

/** Extract stable HTTP(S) targets from one Discord message without fetching them. */
export function extractMessageUrls(content: string): string[] {
  const urls = new Set<string>();
  for (const match of content.matchAll(URL_PATTERN)) {
    const normalized = normalizeHttpUrl(trimUrlPunctuation(match[0]));
    if (normalized !== null) urls.add(normalized);
  }
  return [...urls];
}

function normalizeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function trimUrlPunctuation(value: string): string {
  let result = value;
  while (/[.,!?;:]$/u.test(result)) result = result.slice(0, -1);
  while (result.endsWith(")") && count(result, ")") > count(result, "(")) result = result.slice(0, -1);
  while (result.endsWith("]") && count(result, "]") > count(result, "[")) result = result.slice(0, -1);
  return result;
}

function count(value: string, token: string): number {
  return value.split(token).length - 1;
}
