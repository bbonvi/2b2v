/** Channel-level actions abstracted from Discord. */
export interface ChannelActions {
  sendReply: (text: string) => Promise<string>;
  sendMessage: (text: string) => Promise<string>;
  startTyping: () => void;
}

/**
 * Create a MessageSender that:
 * - Sends the first message as a reply
 * - Sends subsequent messages as normal channel messages
 * - Shows typing indicator before each send
 */
export function createMultiMessageSender(
  actions: ChannelActions
): (
  messages: { text: string }[],
  signal?: AbortSignal
) => Promise<{ sentMessageIds: string[] }> {
  return async (messages, signal) => {
    const sentMessageIds: string[] = [];

    for (let i = 0; i < messages.length; i++) {
      if (signal !== undefined && signal.aborted) break;

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
