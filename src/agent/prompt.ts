/** A message in the chat history for system prompt injection. */
export interface ChatMessage {
  author: string;
  content: string;
  isBot: boolean;
}
