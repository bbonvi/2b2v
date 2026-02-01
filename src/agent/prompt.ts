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
  guildId: string;
  channelId: string;
  timestamp: string;
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
To send a message, you MUST call the \`send_message\` tool. This is the ONLY way your words reach the chat.
If you want to reply, call \`send_message\` with \`reply: true\`. If you want to ignore user, do not call it (only do it for a good reason; prefer to always reply).
You may split responses into multiple \`send_message\` calls (to make it more chat-like and human). Use \`reply: true\` on the first message when responding to the trigger, and \`reply: false\` for follow-up messages.
Do no repeat your messages.
Always send at least one message to the user — do not let them hanging.
If you keep researching for a few tool calls in a row send user a message letting them now that you're still processing.
If something went wong with your tool calls you might wanna let user know.
If you want to call additional tools before reply, like web_search, you may want to first use \`send_message\` tool to inform user that you are processing their request. But keep that coherent - as a normal person would.
If user's request is fully fulfilled do not send them identical information - just stop.

Despite those constraints, keep yourself in-character and reply how a character would.

## Available Tools
- \`send_message\` — Send a message to the current channel (REQUIRED for any response). Set \`reply: true\` to reply to the trigger.
- \`save_memory\` / \`delete_memory\` / \`list_memories\` — Persist information across conversations
- \`search_messages\` — Semantic search over past messages in this server
- \`schedule_message\` — Schedule a message to be sent later
- \`list_members\` — List server members (online/all)
- \`channel_history\` — Read recent messages from a channel
- \`web_search\` — Search the web via Brave Search (if available). Only call once or twice.`;

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

  sections.push(`## Current Context\nGuild: ${ctx.guildId} | Channel: ${ctx.channelId}\nDate/Time: ${ctx.timestamp}`);

  const history = formatChatHistory(ctx.chatHistory);
  if (history !== "") {
    sections.push(`## Chat History\n${history}`);
  }

  return sections.join("\n\n");
}
