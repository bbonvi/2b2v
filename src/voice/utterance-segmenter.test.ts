import { describe, expect, test } from "bun:test";
import {
  anchorUtteranceToWallClock,
  VoiceUtteranceSegmenter,
} from "./utterance-segmenter.ts";

const config = {
  minUtteranceMs: 100,
  maxUtteranceMs: 2_000,
  speechPauseMs: 200,
  speechPreRollMs: 100,
  speechRmsThreshold: 0.015,
};

function pcm(ms: number, amplitude: number): Buffer {
  const samples = ms * 48 * 2;
  const output = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    output.writeInt16LE(index % 2 === 0 ? amplitude : -amplitude, index * 2);
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
    expect(anchorUtteranceToWallClock({
      startedOffsetMs: 2_000,
      endedOffsetMs: 3_000,
      finalizationLagMs: 200,
    }, 120_000)).toEqual({
      startedAt: 118_800,
      endedAt: 119_800,
    });
  });

  test("finishes on a speech-energy pause even while quiet PCM packets continue", () => {
    const segmenter = new VoiceUtteranceSegmenter(config);
    segmenter.push(pcm(100, 100));
    const started = segmenter.push(pcm(200, 3_000));
    expect(started.speechStarted).toBe(true);
    expect(segmenter.activeSpeechMs).toBe(200);
    const ended = segmenter.push(pcm(220, 100));

    expect(ended.utterances).toHaveLength(1);
    expect(ended.utterances[0]?.speechMs).toBe(200);
    expect(segmenter.isSpeaking).toBe(false);
  });

  test("does not treat constant low-level microphone noise as speech", () => {
    const segmenter = new VoiceUtteranceSegmenter(config);
    const result = segmenter.push(pcm(1_000, 200));
    expect(result.speechStarted).toBe(false);
    expect(result.utterances).toEqual([]);
    expect(segmenter.flush()).toEqual([]);
  });

  test("keeps bounded pre-roll and discards clicks shorter than the minimum", () => {
    const segmenter = new VoiceUtteranceSegmenter(config);
    segmenter.push(pcm(500, 100));
    segmenter.push(pcm(40, 3_000));
    const result = segmenter.push(pcm(220, 100));
    expect(result.utterances).toEqual([]);
  });
});
