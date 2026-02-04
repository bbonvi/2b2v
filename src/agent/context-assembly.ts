/**
 * Structured context assembly for multi-message LLM context.
 *
 * Produces an ordered array of system sections with per-section cache control,
 * plus a separate latest user message. Empty sections are omitted.
 */

/** A single system section in the assembled context. */
export interface ContextSection {
  /** Section label for debugging/logging (not sent to LLM). */
  label: string;
  /** The text content of this section. */
  text: string;
  /** Whether this section should be cached (cache_control). */
  cached: boolean;
}

/** The full assembled context ready for LLM submission. */
export interface AssembledContext {
  /** Ordered system sections. */
  sections: ContextSection[];
  /** The formatted latest user message (role=user). */
  userMessage: string;
}

/** Thread metadata for thread context assembly. */
export interface ThreadMetadata {
  parentChatId: string;
  threadId: string;
  starterMessageId: string;
  threadName: string;
}

/** Input for context assembly. All string fields may be empty to indicate omission. */
export interface ContextAssemblyInput {
  persona: string;
  toolInstructions: string;
  instructions: string;
  emojis: string;
  members: string;
  journalSummaries: string;
  upcomingSchedules: string;
  /** Threads in this chat (for parent channels only). */
  threadsInChat: string;
  /** Thread metadata (for thread channels only). */
  threadMetadata?: ThreadMetadata;
  /** Parent channel pre-context (for thread channels only). Formatted history text. */
  parentPreContext: string;
  olderHistory: string;
  newerHistory: string;
  currentContext: string;
  /** Optional high-priority instruction placed after all history/context sections. */
  lateInstruction: string;
  userMessage: string;
}

/**
 * Assemble structured context from input sections.
 *
 * Section order per spec (parent channel):
 * 1. Persona (cached)
 * 2. Tool Instructions (cached)
 * 3. Instructions (cached) — if any
 * 4. Available Emojis (cached)
 * 5. Server Members (cached)
 * 6. Upcoming Schedules (cached) — if any
 * 7. Threads In This Chat (uncached) — if any (parent channels only)
 * 8. Chat History — Older (cached)
 * 9. Journal Summaries (uncached) — if any
 * 10. Chat History — Newer (uncached)
 * 11. Current Context (uncached)
 * 12. Late Instruction (uncached) — if any
 *
 * Section order per spec (thread channel):
 * 1. Persona (cached)
 * 2. Tool Instructions (cached)
 * 3. Instructions (cached) — if any
 * 4. Available Emojis (cached)
 * 5. Server Members (cached)
 * 6. Upcoming Schedules (cached) — if any
 * 7. Thread Metadata (uncached) — thread context only
 * 8. Parent Pre-Context (cached) — thread context only
 * 9. Chat History — Older (cached)
 * 10. Journal Summaries (uncached) — if any
 * 11. Chat History — Newer (uncached)
 * 12. Current Context (uncached)
 * 13. Late Instruction (uncached) — if any
 *
 * Empty sections are omitted entirely.
 */
export function assembleContext(input: ContextAssemblyInput): AssembledContext {
  const sections: ContextSection[] = [];

  const add = (label: string, text: string, cached: boolean): void => {
    if (text !== "") {
      sections.push({ label, text, cached });
    }
  };

  const addWithHeader = (label: string, header: string, content: string, cached: boolean): void => {
    if (content !== "") {
      sections.push({ label, text: `${header}\n${content}`, cached });
    }
  };

  add("Persona", input.persona, true);
  add("Tool Instructions", input.toolInstructions, true);
  addWithHeader("Instructions", "## Instructions", input.instructions, true);
  addWithHeader("Available Emojis", "## Available Emojis", input.emojis, true);
  addWithHeader("Server Members", "## Server Members", input.members, true);
  addWithHeader("Upcoming Schedules", "## Upcoming Schedules", input.upcomingSchedules, true);

  // Parent channel: show threads in this chat
  addWithHeader("Threads In This Chat", "## Threads In This Chat", input.threadsInChat, false);

  // Thread channel: show thread metadata and parent pre-context
  if (input.threadMetadata !== undefined) {
    const meta = input.threadMetadata;
    const metaContent = [
      `Parent Chat: ${meta.parentChatId}`,
      `Thread: ${meta.threadId}`,
      `Starter Message: ${meta.starterMessageId}`,
      `Thread Name: "${meta.threadName}"`,
    ].join("\n");
    addWithHeader("Thread Metadata", "## Thread Metadata", metaContent, false);
  }
  add("Parent Pre-Context", input.parentPreContext, true);

  add("Chat History — Older", input.olderHistory, true);
  addWithHeader("Journal Summaries", "## Journal", input.journalSummaries, false);
  add("Chat History — Newer", input.newerHistory, false);
  add("Current Context", input.currentContext, false);
  add("Late Instruction", input.lateInstruction, false);

  return {
    sections,
    userMessage: input.userMessage,
  };
}

/**
 * Serialize assembled context sections into a single system prompt string.
 *
 * Sections are joined with double-newline separators. Stable (cached) sections
 * are placed first by design, so Anthropic's prefix-based prompt caching
 * automatically caches the stable prefix across calls.
 */
export function contextToSystemPrompt(ctx: AssembledContext): string {
  return ctx.sections.map((s) => s.text).join("\n\n");
}
