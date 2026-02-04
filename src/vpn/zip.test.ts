import { describe, test, expect } from "bun:test";
import { generateZip } from "./zip.ts";
import { unzipSync } from "fflate";

describe("generateZip", () => {
  test("returns a valid zip buffer", () => {
    const config = "[Interface]\nPrivateKey = test\n";
    const buffer = generateZip(config, "eu1.conf");

    expect(buffer).toBeInstanceOf(Buffer);
    // ZIP magic bytes (PK)
    expect(buffer[0]).toBe(0x50); // P
    expect(buffer[1]).toBe(0x4b); // K
  });

  test("contains the specified file with correct content", () => {
    const config = "[Interface]\nPrivateKey = testkey\nAddress = 10.0.0.1/32\n";
    const buffer = generateZip(config, "germany.conf");

    const unzipped = unzipSync(buffer);
    expect(Object.keys(unzipped)).toEqual(["germany.conf"]);
    expect(new TextDecoder().decode(unzipped["germany.conf"])).toBe(config);
  });
});
