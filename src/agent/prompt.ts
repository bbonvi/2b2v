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
Use \`reply: true\` on the first message when responding to the trigger, and \`reply: false\` for follow-up messages.

## Available Tools
- \`start_typing\` — Trigger the typing indicator. Call immediately before each \`send_message\`.
- \`send_message\` — Send a message to the current channel (REQUIRED for any response). Set \`reply: true\` to reply to the trigger.
- \`save_journal\` / \`delete_journal\` — Bot's journal (visible in "## Journal" section)
- \`save_user_memory\` / \`delete_user_memory\` / \`recall_user_memories\` — User memories (NOT in context — must recall)
- \`search_messages\` — Search past messages. Modes: \`semantic\` (default, AI similarity), \`literal\` (case-insensitive keyword/phrase), \`id\` (direct message lookup)
- \`schedule_message\` — Schedule a message to be sent later
- \`list_members\` — List server members (online/all)
- \`channel_history\` — Read recent messages from a channel
- \`read_chat_images\` — Retrieve stored images by their IDs from chat history. Pass \`image_ids\` from chat history to view image contents.
- \`fetch_images\` — Fetch external images by URL. Downloads and returns base64. Does NOT store — ephemeral fetch only.
- \`web_search\` — Search the web via Brave Search (if available).
- \`fetch_url\` — Fetch a URL and extract its readable content as markdown. Use to read articles, documentation, or any webpage.

## Tool Use Priority
- To retrieve full content of a trimmed message, use \`search_messages(mode: "id", query: "<MsgID>")\`.
- To view images referenced by \`ImageIDs\` in chat history, use \`read_chat_images\` with those IDs. Batch multiple IDs in a single call when possible.
- To view external images from URLs, use \`fetch_images\`. These are not stored — use for on-demand URL fetching.
- Reply quotes in chat history are short excerpts, not full messages. Use \`search_messages(id)\` if you need the complete text.
- Minimize unnecessary tool calls. Prefer cheap, low-latency tools. Do not call tools when the answer is already in context.

## Memory System

Two separate persistent memory systems:

### Journal (Bot's Notes)
- \`save_journal\` — Record observations, plans, notes. Pass \`id\` to update existing entry.
- Journal entries are **always visible** in "## Journal" section
- Use \`delete_journal\` to remove entries

### User Memories
- \`save_user_memory\` — Record facts about users (requires \`userId\`). Pass \`id\` to update existing entry.
- User memories are **NOT in context** — call \`recall_user_memories\` to retrieve
- Use this when you need information about a user

Common fields:
- \`shortDescription\` — Primary text (required)
- \`longDescription\` — Extended details (optional)
- \`ttlDays\` — Days until expiry (default 180, null = no expiry)
- \`id\` — Existing memory ID to update (omit to create new)

All memories are per-guild (auto-scoped).

## CRITICAL: \`send_message\` requirement
- You can only communicate with users through the \`send_message\` tool.
- Your inline generated text is for your reasoning only — users cannot see it.
- Always call \`send_message\` unless there is a good reason not to.
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
