import type { Message } from "discord.js";
import type { MessageAsset } from "../db/asset-repository.ts";
import type { ResolvedAssetSource } from "../agent/read-asset-tool.ts";

export interface DiscordAssetResolverDeps {
  fetchMessage: (channelId: string, messageId: string) => Promise<Message | null>;
}

/** Resolve metadata-only asset references into a fresh live Discord or external URL. */
export function createDiscordAssetSourceResolver(deps: DiscordAssetResolverDeps): (asset: MessageAsset) => Promise<ResolvedAssetSource | null> {
  return async (asset) => {
    const message = await deps.fetchMessage(asset.channelId, asset.messageId);
    if (message === null) return null;
    if (asset.sourceKind === "attachment") {
      const attachment = message.attachments.get(asset.sourceKey);
      return attachment === undefined ? null : { url: attachment.url, contentType: attachment.contentType, filename: attachment.name };
    }
    if (asset.sourceKind === "embed") {
      const embed = message.embeds[Number(asset.sourceKey)];
      if (embed === undefined) return null;
      const media = embed.video ?? embed.image ?? embed.thumbnail;
      if (media?.url === undefined) return null;
      return {
        url: media.proxyURL ?? media.url,
        contentType: asset.contentType,
        filename: asset.filename,
      };
    }
    const sticker = message.stickers.get(asset.sourceKey);
    return sticker?.url === undefined ? null : { url: sticker.url, contentType: asset.contentType, filename: sticker.name };
  };
}
