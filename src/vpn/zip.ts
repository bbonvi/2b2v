import { zipSync } from "fflate";

/**
 * Generate a zip file containing a single WireGuard .conf file.
 * @param configText The WireGuard configuration content.
 * @param filename The .conf filename (e.g., "eu1.conf").
 * @returns A Buffer containing the zip archive.
 */
export function generateZip(configText: string, filename: string): Buffer {
  const files: Record<string, Uint8Array> = {
    [filename]: new TextEncoder().encode(configText),
  };
  const zipped = zipSync(files);
  return Buffer.from(zipped);
}
