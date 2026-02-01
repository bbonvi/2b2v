import type { ChatMessage } from "./prompt.ts";
import type { TrimConfig } from "../config/types.ts";

/**
 * Trim chat history by message count using chunked trimming.
 *
 * When message count reaches trim_trigger, drops oldest messages
 * to bring count down to trim_target. This preserves the stable
 * prefix (persona, emojis, etc.) while only the history tail changes.
 */
export function trimChatHistory(
  messages: ChatMessage[],
  trim: TrimConfig
): ChatMessage[] {
  if (messages.length < trim.trimTrigger) {
    return messages;
  }
  return messages.slice(messages.length - trim.trimTarget);
}
