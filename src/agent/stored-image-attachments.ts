import { readFileSync } from "fs";
import type { ImageAttachmentResolver, OutboundAttachment } from "./handler";
import type { Logger } from "../logger";
import type { Database } from "../db/database";
import { getImageById } from "../db/image-repository";
import { imageExtensionForMime } from "../db/image-ingest";

export function createStoredImageAttachmentResolver(input: {
  db: Database;
  guildId: string;
  logger: Logger;
}): ImageAttachmentResolver {
  return (imageIds) => {
    const attachments: OutboundAttachment[] = [];
    for (const imageId of imageIds) {
      const record = getImageById(input.db, imageId);
      if (record === null || record.guildId !== input.guildId) {
        input.logger.warn("stored image attachment not found", { imageId, guildId: input.guildId });
        continue;
      }
      let buffer: Buffer;
      try {
        buffer = Buffer.from(readFileSync(record.path));
      } catch (error) {
        input.logger.warn("stored image attachment read failed", {
          imageId,
          path: record.path,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      attachments.push({
        id: `chat-image-${record.id}`,
        buffer,
        filename: `chat-image-${record.id}.${imageExtensionForMime(record.mime)}`,
        contentType: record.mime,
        historyText: record.caption ?? `Reposted stored ImageID ${record.id}.`,
      });
    }
    return Promise.resolve(attachments);
  };
}
