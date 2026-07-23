import { StickerFormatType, type Message } from "discord.js";
import type { AssetKind, UpsertMessageAsset } from "../db/asset-repository.ts";

const TEXT_EXTENSIONS = /\.(?:c|cc|conf|cpp|css|csv|eml|go|h|hpp|htm|html|ini|java|js|json|jsx|log|md|py|rb|rs|sh|sql|svg|toml|ts|tsx|txt|xml|yaml|yml)$/i;

export interface DiscordMessageAssetData {
  id: string;
  guildId: string;
  channelId: string;
  createdAt: number;
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
  for (const embed of message.embeds) {
    const url = embed.video?.url ?? embed.image?.url ?? embed.thumbnail?.url;
    if (url !== undefined) {
      const provider = embed.providerName?.toLowerCase();
      const gifLike = embed.type === "gifv" || provider === "tenor" || provider === "giphy";
      assets.push({
        ...base,
        sourceKind: "embed",
        sourceKey: String(embedIndex),
        kind: classifyAsset(embed.video !== null && embed.video !== undefined ? "video/mp4" : null, embed.url ?? url, gifLike),
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
    const formatType = sticker.formatType as StickerFormatType;
    const kind: AssetKind = formatType === StickerFormatType.GIF || formatType === StickerFormatType.APNG
      ? "gif"
      : formatType === StickerFormatType.PNG ? "image" : "file";
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
