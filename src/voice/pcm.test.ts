import { describe, expect, test } from "bun:test";
import { DiscordPcmToMono16k } from "./pcm.ts";

function stereo48k(frames: Array<[number, number]>): Buffer {
  const output = Buffer.alloc(frames.length * 4);
  for (const [index, [left, right]] of frames.entries()) {
    output.writeInt16LE(left, index * 4);
    output.writeInt16LE(right, index * 4 + 2);
  }
  return output;
}

describe("DiscordPcmToMono16k", () => {
  test("downmixes stereo and decimates exact groups across chunk boundaries", () => {
    const converter = new DiscordPcmToMono16k();
    expect(converter.push(stereo48k([[300, 0], [300, 0]]))).toHaveLength(0);
    const first = converter.push(stereo48k([[300, 0], [-600, 0], [-600, 0], [-600, 0]]));
    expect([...new Int16Array(first.buffer, first.byteOffset, first.length / 2)]).toEqual([150, -300]);
  });
});
