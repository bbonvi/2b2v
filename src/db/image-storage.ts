import { join } from "path";

/**
 * Deterministic storage path for a processed image.
 * Format: {attachmentsDir}/{guildId}-{channelId}/images/{imageId}.jpg
 */
export function imagePath(
  attachmentsDir: string,
  guildId: string,
  channelId: string,
  imageId: number,
): string {
  return join(attachmentsDir, `${guildId}-${channelId}`, "images", `${imageId}.jpg`);
}
