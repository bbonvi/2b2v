export interface VoiceTriggerState {
  attentionUntil: number;
}

export interface VoiceTriggerDecision {
  shouldConsider: boolean;
  attentionUntil: number;
  reason: "single_human" | "wake_word" | "lingering" | "none";
}

function normalizedWords(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Decide whether a finalized utterance deserves a voice-agent turn. */
export function decideVoiceTrigger(input: {
  text: string;
  humanCount: number;
  wakeWords: readonly string[];
  now: number;
  lingeringAttentionMs: number;
  state: VoiceTriggerState;
}): VoiceTriggerDecision {
  if (input.humanCount <= 1) {
    return {
      shouldConsider: input.text.trim() !== "",
      attentionUntil: input.now + input.lingeringAttentionMs,
      reason: "single_human",
    };
  }

  const words = new Set(normalizedWords(input.text));
  const wake = input.wakeWords.some((word) => {
    const parts = normalizedWords(word);
    return parts.length === 1 && words.has(parts[0] ?? "");
  });
  if (wake) {
    return {
      shouldConsider: true,
      attentionUntil: input.now + input.lingeringAttentionMs,
      reason: "wake_word",
    };
  }
  if (input.state.attentionUntil >= input.now) {
    return {
      shouldConsider: true,
      attentionUntil: input.state.attentionUntil,
      reason: "lingering",
    };
  }
  return { shouldConsider: false, attentionUntil: input.state.attentionUntil, reason: "none" };
}
