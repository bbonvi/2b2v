import { describe, expect, test } from "bun:test";
import { decideVoiceTrigger } from "./trigger.ts";

describe("decideVoiceTrigger", () => {
  test("considers every meaningful utterance with one human", () => {
    const decision = decideVoiceTrigger({
      text: "Are you there?",
      humanCount: 1,
      wakeWords: ["2b", "туби"],
      now: 100,
      lingeringAttentionMs: 45_000,
      state: { attentionUntil: 0 },
    });
    expect(decision.reason).toBe("single_human");
    expect(decision.shouldConsider).toBe(true);
  });

  test("uses exact wake tokens and does not match English to be", () => {
    const common = {
      humanCount: 3,
      wakeWords: ["2b", "туби"],
      now: 100,
      lingeringAttentionMs: 45_000,
      state: { attentionUntil: 0 },
    };
    expect(decideVoiceTrigger({ ...common, text: "2B, what do you think?" })).toMatchObject({
      reason: "wake_word",
      wakeWord: "2b",
    });
    expect(decideVoiceTrigger({ ...common, text: "Туби, ты здесь?" }).reason).toBe("wake_word");
    expect(decideVoiceTrigger({ ...common, text: "I want to be precise." }).shouldConsider).toBe(false);
  });

  test("keeps bounded lingering attention", () => {
    const decision = decideVoiceTrigger({
      text: "And after that?",
      humanCount: 2,
      wakeWords: ["2b"],
      now: 500,
      lingeringAttentionMs: 45_000,
      state: { attentionUntil: 1_000 },
    });
    expect(decision.reason).toBe("lingering");
  });
});
