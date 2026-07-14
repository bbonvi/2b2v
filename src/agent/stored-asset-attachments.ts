import type { AssetAttachmentResolver, OutboundAttachment } from "./handler.ts";
import type { Database } from "../db/database.ts";
import type { Logger } from "../logger.ts";
import { getAssetById } from "../db/asset-repository.ts";
import type { ResolvedAssetSource } from "./read-asset-tool.ts";
import { fetchAssetBuffer } from "./read-asset-tool.ts";

/** Resolve prompt-visible asset IDs into exact outgoing Discord uploads on demand. */
export function createStoredAssetAttachmentResolver(input: {
  db: Database;
  guildId: string;
  maxDownloadBytes: number;
  resolveSource: (asset: NonNullable<ReturnType<typeof getAssetById>>) => Promise<ResolvedAssetSource | null>;
  logger: Logger;
}): AssetAttachmentResolver {
  return async (assetIds) => {
    const attachments: OutboundAttachment[] = [];
    for (const id of assetIds) {
      const asset = getAssetById(input.db, id);
      if (asset === null || asset.guildId !== input.guildId) {
        input.logger.warn("asset attachment not found", { assetId: id, guildId: input.guildId });
        continue;
      }
      const source = await input.resolveSource(asset);
      if (source === null) {
        input.logger.warn("asset source unavailable", { assetId: id });
        continue;
      }
      try {
        attachments.push({
          id: `asset-${id}`,
          buffer: await fetchAssetBuffer(fetch, source.url, input.maxDownloadBytes),
          filename: source.filename ?? asset.filename ?? `asset-${id}`,
          contentType: source.contentType ?? asset.contentType ?? "application/octet-stream",
          historyText: `Reposted ${asset.kind} asset ${id}.`,
        });
      } catch (error) {
        input.logger.warn("asset download failed", { assetId: id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return attachments;
  };
}
