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
export function assembleSystemPrompt(ctx: PromptContext): string {
  const sections: string[] = [ctx.persona];

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
