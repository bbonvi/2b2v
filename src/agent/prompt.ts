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
export const TOOL_INSTRUCTIONS = `## How You Communicate
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
- \`search_messages\` — Search past messages. Modes: \`semantic\` (default, AI similarity), \`literal\` (case-insensitive keyword/phrase), \`id\` (direct message lookup)
- \`schedule_message\` — Schedule a message to be sent later
- \`list_members\` — List server members (online/all)
- \`channel_history\` — Read recent messages from a channel
- \`read_images\` — Retrieve stored images by their IDs. Pass \`image_ids\` from chat history to view image contents.
- \`web_search\` — Search the web via Brave Search (if available). Only call once or twice.

## Tool Use Priority
- To retrieve full content of a trimmed message, use \`search_messages(mode: "id", query: "<MsgID>")\`.
- To view images referenced by \`ImageIDs\` in chat history, use \`read_images\` with those IDs. Batch multiple IDs in a single call when possible.
- Reply quotes in chat history are short excerpts, not full messages. Use \`search_messages(id)\` if you need the complete text.
- Minimize unnecessary tool calls. Prefer cheap, low-latency tools. Do not call tools when the answer is already in context.
- Do always call for \`send_message\` otherwise your message will not be deliever.
- Prefer to call \`send_message\` at the very end of your agentic turn.
- Heavily utilize "memory"-related tools to manage your long-term memory.
- When user asks to remind or plan for something use \`schedule_message\` tool.
- Use semantic search when something's unclear.
- Do not invent facts.

## Memory System

The chat history is highly limited, but you have access to persistent memory system. Use it to record and retrieve information about specific users or your own internal thoughts, plans or ideas. Heavily utilize the memory feature and always try to pull out information relevant to certain users.

Scopes:
- **user** — per-user facts (e.g., preferences, names). Requires \`userId\`.
- **journal** — bot's own notes, plans, observations. No \`userId\` needed (auto-injected).

Both scopes support \`shortDescription\`/\`longDescription\` for structured entries.
All memories are per-guild (auto-scoped). Default TTL is 180 days, configurable via \`ttlDays\`. Pass \`ttlDays: null\` for no expiry.

Always proactively save important information about user

# \`send_message\` importance

Once again, remember to call \`send_message\` to actually reply to user request or a message

CRITICAL:
- You can only communicate with user through the use of \`send_message\`.
- Your inline generated text is for your reasoning only!
- Always \`send_message\` unless there is a good reason not to.
`;

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
