import QRCode from "qrcode";

/**
 * Generate a QR code PNG buffer from a WireGuard config string.
 * Returns a Buffer usable as a Discord attachment.
 */
export async function generateQr(configText: string): Promise<Buffer> {
  return QRCode.toBuffer(configText, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    scale: 8,
  });
}
