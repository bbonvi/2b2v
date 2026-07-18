import { describe, expect, test } from "bun:test";
import {
  anchorUtteranceToWallClock,
  VoiceUtteranceSegmenter,
  VOICE_VAD_FRAME_BYTES,
} from "./utterance-segmenter.ts";

const config = {
  minUtteranceMs: 96,
  maxUtteranceMs: 2_000,
  speechPauseMs: 192,
  speechPreRollMs: 96,
  vadThreshold: 0.5,
};

function frame(amplitude = 100): Buffer {
  const output = Buffer.alloc(VOICE_VAD_FRAME_BYTES);
  for (let offset = 0; offset < output.length; offset += 2) {
    output.writeInt16LE(amplitude, offset);
  }
  return output;
}

describe("VoiceUtteranceSegmenter", () => {
  test("anchors each utterance to wall time instead of compressed stream offsets", () => {
    expect(anchorUtteranceToWallClock({
      startedOffsetMs: 1_000,
      endedOffsetMs: 2_000,
      finalizationLagMs: 200,
    }, 100_000)).toEqual({
      startedAt: 98_800,
      endedAt: 99_800,
    });
  });

  test("streams only after confirmation and holds possible ending silence locally", () => {
    const segmenter = new VoiceUtteranceSegmenter(config);
    segmenter.push(frame(), 0.01);
    segmenter.push(frame(), 0.01);
    expect(segmenter.push(frame(3_000), 0.9).streamPcm).toEqual([]);
    expect(segmenter.push(frame(3_000), 0.9).streamPcm).toEqual([]);
    const confirmed = segmenter.push(frame(3_000), 0.9);
    expect(confirmed.speechConfirmed).toBe(true);
    expect(confirmed.streamPcm).toHaveLength(5);

    const held = segmenter.push(frame(), 0.01);
    expect(held.streamPcm).toEqual([]);
    const resumed = segmenter.push(frame(3_000), 0.9);
    expect(resumed.streamPcm).toHaveLength(2);
  });

  test("finalizes after a Silero-confirmed pause and retains only trailing context", () => {
    const segmenter = new VoiceUtteranceSegmenter(config);
    for (let index = 0; index < 3; index += 1) segmenter.push(frame(3_000), 0.9);
    let result = segmenter.push(frame(), 0.01);
    for (let index = 0; index < 5; index += 1) result = segmenter.push(frame(), 0.01);

    expect(result.utterances).toHaveLength(1);
    expect(result.utterances[0]?.speechMs).toBe(96);
    expect(result.streamPcm).toHaveLength(1);
    expect(result.streamPcm[0]).toHaveLength(VOICE_VAD_FRAME_BYTES * 3);
    expect(segmenter.isSpeaking).toBe(false);
  });

  test("discards clicks that never reach the minimum speech duration", () => {
    const segmenter = new VoiceUtteranceSegmenter(config);
    segmenter.push(frame(3_000), 0.9);
    let result = segmenter.push(frame(), 0.01);
    for (let index = 0; index < 5; index += 1) result = segmenter.push(frame(), 0.01);
    expect(result.utterances).toEqual([]);
    expect(result.streamPcm).toEqual([]);
  });
});
