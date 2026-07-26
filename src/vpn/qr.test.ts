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
});
