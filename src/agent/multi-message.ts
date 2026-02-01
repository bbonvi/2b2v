/** Delay configuration for inter-message pauses. */
export interface MessageDelayConfig {
  base: number;
  perChar: number;
}

/** Channel-level actions abstracted from Discord. */
export interface ChannelActions {
  sendReply: (text: string) => Promise<string>;
  sendMessage: (text: string) => Promise<string>;
  startTyping: () => void;
  delay: (ms: number) => Promise<void>;
}

/** Compute delay in ms for a message based on its text length. */
export function computeDelay(text: string, config: MessageDelayConfig): number {
  return config.base + text.length * config.perChar;
}

/**
 * Create a MessageSender that:
 * - Sends the first message as a reply
 * - Sends subsequent messages as normal channel messages
 * - Shows typing indicator before each send
 * - Delays between messages using the configurable formula
 */
export function createMultiMessageSender(
  actions: ChannelActions,
  config: MessageDelayConfig
): (
  messages: { text: string }[],
  signal?: AbortSignal
) => Promise<{ sentMessageIds: string[] }> {
  return async (messages, signal) => {
    const sentMessageIds: string[] = [];

    for (let i = 0; i < messages.length; i++) {
      if (signal !== undefined && signal.aborted) break;

      // Delay before follow-up messages (not the first)
      if (i > 0) {
        const msg = messages[i];
        if (msg === undefined) break;
        const delayMs = computeDelay(msg.text, config);
        await actions.delay(delayMs);
        if (signal !== undefined && signal.aborted) break;
      }

      actions.startTyping();

      const currentMsg = messages[i];
      if (currentMsg === undefined) break;

      const id =
        i === 0
          ? await actions.sendReply(currentMsg.text)
          : await actions.sendMessage(currentMsg.text);

      sentMessageIds.push(id);
    }

    return { sentMessageIds };
  };
}
