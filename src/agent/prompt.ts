import { readFileSync } from "fs";

/** A message in the chat history for system prompt injection. */
export interface ChatMessage {
  author: string;
  content: string;
  isBot: boolean;
}

/** All data needed to assemble the system prompt. */
export interface PromptContext {
  persona: string;
  journalSummaries: string[];
  upcomingSchedules: string[];
  chatHistory: ChatMessage[];
  emojiContext: string;
  displayNameContext: string;
}

/** Load persona markdown from disk. Throws if file is missing. */
export function loadPersona(filePath: string): string {
  return readFileSync(filePath, "utf-8").trim();
}

/** Format chat messages into a human-readable block for the system prompt. */
export function formatChatHistory(messages: ChatMessage[]): string {
  if (messages.length === 0) return "";
  return messages.map((m) => `${m.author}: ${m.content}`).join("\n");
}

/**
 * Assemble the full system prompt from all context sections.
 *
 * Order: persona → emojis → members → journal → schedules → chat history.
 * Empty sections are omitted entirely.
 */
const TOOL_INSTRUCTIONS = `## How You Communicate
You are a Discord bot. You do NOT have the ability to send messages directly — your text output is invisible to users.
To send a message, you MUST call the \`send_messages\` tool. This is the ONLY way your words reach the chat.
If you want to reply, call \`send_messages\`. If you want to stay silent, do not call it.
You may split long responses into multiple messages. The first message is automatically a reply; subsequent messages are sent as normal channel messages.

## Available Tools
- \`send_messages\` — Send messages to the current channel (REQUIRED for any response)
- \`save_memory\` / \`delete_memory\` / \`list_memories\` — Persist information across conversations
- \`search_messages\` — Semantic search over past messages in this server
- \`schedule_message\` — Schedule a message to be sent later
- \`list_members\` — List server members (online/all)
- \`channel_history\` — Read recent messages from a channel
- \`web_search\` — Search the web via Brave Search (if available)`;

export function assembleSystemPrompt(ctx: PromptContext): string {
  const sections: string[] = [ctx.persona, TOOL_INSTRUCTIONS];

  if (ctx.emojiContext !== "") {
    sections.push(`## Available Emojis\n${ctx.emojiContext}`);
  }

  if (ctx.displayNameContext !== "") {
    sections.push(`## Server Members\n${ctx.displayNameContext}`);
  }

  if (ctx.journalSummaries.length > 0) {
    const items = ctx.journalSummaries.map((s) => `- ${s}`).join("\n");
    sections.push(`## Journal\n${items}`);
  }

  if (ctx.upcomingSchedules.length > 0) {
    const items = ctx.upcomingSchedules.map((s) => `- ${s}`).join("\n");
    sections.push(`## Upcoming Schedules\n${items}`);
  }

  const history = formatChatHistory(ctx.chatHistory);
  if (history !== "") {
    sections.push(`## Chat History\n${history}`);
  }

  return sections.join("\n\n");
}
