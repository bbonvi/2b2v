export interface VoiceTriggerState {
  attentionUntil: number;
  attentionOwnerUserId?: string;
}

export interface VoiceTriggerDecision {
  shouldConsider: boolean;
  attentionUntil: number;
  reason: "single_human" | "wake_word" | "lingering" | "none";
  wakeWord?: string;
  attentionOwnerUserId?: string;
}

function normalizedWords(text: string): string[] {
  return text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Decide whether a finalized utterance deserves a voice-agent turn. */
export function decideVoiceTrigger(input: {
  text: string;
  userId: string;
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
      attentionOwnerUserId: input.userId,
    };
  }

  const words = new Set(normalizedWords(input.text));
  const wakeWord = input.wakeWords.find((word) => {
    const parts = normalizedWords(word);
    return parts.length === 1 && words.has(parts[0] ?? "");
  });
  if (wakeWord !== undefined) {
    return {
      shouldConsider: true,
      attentionUntil: input.now + input.lingeringAttentionMs,
      reason: "wake_word",
      wakeWord,
      attentionOwnerUserId: input.userId,
    };
  }
  if (
    input.state.attentionUntil >= input.now
    && input.state.attentionOwnerUserId === input.userId
  ) {
    return {
      shouldConsider: true,
      attentionUntil: input.state.attentionUntil,
      reason: "lingering",
      attentionOwnerUserId: input.userId,
    };
  }
  return {
    shouldConsider: false,
    attentionUntil: input.state.attentionUntil,
    reason: "none",
    ...(input.state.attentionOwnerUserId === undefined
      ? {}
      : { attentionOwnerUserId: input.state.attentionOwnerUserId }),
  };
}
