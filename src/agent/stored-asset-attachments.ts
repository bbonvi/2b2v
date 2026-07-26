import type { AssetAttachmentResolver, OutboundAttachment } from "./handler.ts";
import type { Database } from "../db/database.ts";
import type { Logger } from "../logger.ts";
import { getAssetById } from "../db/asset-repository.ts";
import type { ResolvedAssetSource } from "./read-asset-tool.ts";
import { fetchAssetBuffer } from "./read-asset-tool.ts";
import { getStagedAsset } from "../db/staged-asset-repository.ts";
import { imageMimeFromBuffer } from "./image-buffer.ts";
import type { LinkCacheMode, ResolvedLinkResult } from "./link-content.ts";

/** Resolve prompt-visible asset IDs into exact outgoing Discord uploads on demand. */
export function createStoredAssetAttachmentResolver(input: {
  db: Database;
  maxDownloadBytes: number;
  resolveSource: (asset: NonNullable<ReturnType<typeof getAssetById>>) => Promise<ResolvedAssetSource | null>;
  logger: Logger;
  stagedGuildId?: string;
  fetchFn?: typeof fetch;
  resolveLink?: (input: { url: string; cacheMode?: LinkCacheMode; raw?: boolean }, signal?: AbortSignal) => Promise<ResolvedLinkResult>;
}): AssetAttachmentResolver {
  return async (assetIds) => {
    const attachments: OutboundAttachment[] = [];
    const seen = new Set<string>();
    for (const id of assetIds) {
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      if (typeof id === "string") {
        const staged = getStagedAsset(input.db, id);
        if (staged === null
          || staged.deliveredMessageId !== undefined
          || (input.stagedGuildId !== undefined && staged.ownerGuildId !== input.stagedGuildId)) {
          input.logger.warn("staged asset attachment not found or out of scope", { assetRef: id });
          continue;
        }
        try {
          const file = Bun.file(staged.storagePath);
          if (!await file.exists()) throw new Error("staged file is missing");
          if (file.size > input.maxDownloadBytes) {
            throw new Error(`staged file exceeds ${input.maxDownloadBytes} byte limit`);
          }
          attachments.push({
            id: `staged-${staged.ref}`,
            buffer: Buffer.from(await file.arrayBuffer()),
            filename: staged.filename,
            contentType: staged.contentType,
          });
        } catch (error) {
          input.logger.warn("staged asset read failed", {
            assetRef: id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
      const asset = getAssetById(input.db, id);
      if (asset === null) {
        input.logger.warn("asset attachment not found", { assetId: id });
        continue;
      }
      const source = await input.resolveSource(asset);
      if (source === null) {
        input.logger.warn("asset source unavailable", { assetId: id });
        continue;
      }
      try {
        if (asset.kind === "link") {
          if (input.resolveLink === undefined) throw new Error("Link media resolution is unavailable");
          const resolved = await input.resolveLink({ url: source.url });
          if (
            resolved.content.kind !== "image"
            && resolved.content.kind !== "gif"
            && resolved.content.kind !== "audio"
            && resolved.content.kind !== "video"
          ) {
            throw new Error(`Link resolved to non-media content (${resolved.content.kind})`);
          }
          const buffer = await fetchAssetBuffer(input.fetchFn ?? fetch, source.url, input.maxDownloadBytes);
          const contentType = resolved.content.kind === "image" || resolved.content.kind === "gif"
            ? imageMimeFromBuffer(buffer, resolved.content.contentType)
            : resolved.content.contentType;
          if (
            (resolved.content.kind === "image" || resolved.content.kind === "gif")
            && !contentType.startsWith("image/")
          ) {
            throw new Error(`Link changed to unsupported content (${contentType})`);
          }
          attachments.push({
            id: `asset-${id}`,
            buffer,
            filename: source.filename ?? `link-${id}`,
            contentType,
          });
          continue;
        }
        attachments.push({
          id: `asset-${id}`,
          buffer: await fetchAssetBuffer(input.fetchFn ?? fetch, source.url, input.maxDownloadBytes),
          filename: source.filename ?? asset.filename ?? `asset-${id}`,
          contentType: source.contentType ?? asset.contentType ?? "application/octet-stream",
        });
      } catch (error) {
        input.logger.warn("asset download failed", { assetId: id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return attachments;
  };
}
