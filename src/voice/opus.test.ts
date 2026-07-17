import { expect, test } from "bun:test";
import prism from "prism-media";

test("Discord voice decoding uses the native Opus backend", () => {
  const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });

  expect(prism.opus.Decoder.type).toBe("@discordjs/opus");

  decoder.destroy();
});
