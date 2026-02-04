import { describe, test, expect } from "bun:test";
import { generateQr } from "./qr.ts";

describe("generateQr", () => {
  test("returns a PNG buffer", async () => {
    const config = "[Interface]\nPrivateKey = test\n";
    const buffer = await generateQr(config);

    expect(buffer).toBeInstanceOf(Buffer);
    // PNG magic bytes
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50); // P
    expect(buffer[2]).toBe(0x4e); // N
    expect(buffer[3]).toBe(0x47); // G
  });

  test("handles multiline config", async () => {
    const config = `[Interface]
PrivateKey = testkey
Address = 10.0.0.1/32
DNS = 1.1.1.1

[Peer]
PublicKey = serverkey
AllowedIPs = 0.0.0.0/0
Endpoint = vpn.example.com:51820`;

    const buffer = await generateQr(config);
    expect(buffer.length).toBeGreaterThan(100);
  });
});
