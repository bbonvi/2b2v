import { join } from "path";

/**
 * Deterministic storage path for a canonical stored image.
 * Format: {attachmentsDir}/{guildId}-{channelId}/images/{imageId}.{extension}
 */
export function imagePath(
  attachmentsDir: string,
  guildId: string,
  channelId: string,
  imageId: number,
  extension: string,
): string {
  return join(attachmentsDir, `${guildId}-${channelId}`, "images", `${imageId}.${extension}`);
}
