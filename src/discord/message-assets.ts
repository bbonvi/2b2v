import { StickerFormatType, type Message } from "discord.js";
import type { AssetKind, UpsertMessageAsset } from "../db/asset-repository.ts";

const TEXT_EXTENSIONS = /\.(?:c|cc|conf|cpp|css|csv|eml|go|h|hpp|htm|html|ini|java|js|json|jsx|log|md|py|rb|rs|sh|sql|svg|toml|ts|tsx|txt|xml|yaml|yml)$/i;

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

/** Convert a live Discord message's uploads, embeds, and stickers into metadata-only asset rows. */
export function assetsFromDiscordMessage(message: Message): UpsertMessageAsset[] {
  if (message.guildId === null) return [];
  const base = { messageId: message.id, guildId: message.guildId, channelId: message.channelId, createdAt: message.createdTimestamp };
  const assets: UpsertMessageAsset[] = [];
  for (const attachment of message.attachments.values()) {
    assets.push({
      ...base,
      sourceKind: "attachment",
      sourceKey: attachment.id,
      kind: classifyAsset(attachment.contentType, attachment.name),
      filename: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
      durationSeconds: attachment.duration,
    });
  }
  message.embeds.forEach((embed, index) => {
    const url = embed.video?.url ?? embed.image?.url ?? embed.thumbnail?.url;
    if (url === undefined) return;
    const gifLike = String(embed.data.type) === "gifv" || embed.provider?.name?.toLowerCase() === "tenor" || embed.provider?.name?.toLowerCase() === "giphy";
    assets.push({
      ...base,
      sourceKind: "embed",
      sourceKey: String(index),
      kind: classifyAsset(embed.video !== null ? "video/mp4" : null, embed.url ?? url, gifLike),
      filename: embed.title ?? null,
      contentType: embed.video !== null ? "video/mp4" : null,
      size: null,
      width: embed.video?.width ?? embed.image?.width ?? embed.thumbnail?.width ?? null,
      height: embed.video?.height ?? embed.image?.height ?? embed.thumbnail?.height ?? null,
      durationSeconds: null,
    });
  });
  for (const sticker of message.stickers.values()) {
    const kind: AssetKind = sticker.format === StickerFormatType.GIF || sticker.format === StickerFormatType.APNG
      ? "gif"
      : sticker.format === StickerFormatType.PNG ? "image" : "file";
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
