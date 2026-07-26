import { describe, test, expect } from "bun:test";
import { generateZip } from "./zip.ts";
import { unzipSync } from "fflate";

describe("generateZip", () => {
  test("contains the specified file with correct content", () => {
    const config = "[Interface]\nPrivateKey = testkey\nAddress = 10.0.0.1/32\n";
    const buffer = generateZip(config, "germany.conf");

    const unzipped = unzipSync(buffer);
    expect(Object.keys(unzipped)).toEqual(["germany.conf"]);
    expect(new TextDecoder().decode(unzipped["germany.conf"])).toBe(config);
  });
});
