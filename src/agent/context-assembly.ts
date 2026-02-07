/** Structured context assembly for multi-message LLM context. */

/** LLM message role for a context section. */
export type SectionRole = "system" | "developer";

/** A single system section in the assembled context. */
export interface ContextSection {
  /** Section label for debugging/logging (not sent to LLM). */
  label: string;
  /** The text content of this section. */
  text: string;
  /** Whether this section should be cached (cache_control). */
  cached: boolean;
  /** LLM message role. "system" for core instructions, "developer" for dynamic context. */
  role: SectionRole;
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

/** Extract only required string-valued keys from T. */
type StringFields<T> = { [K in keyof T]-?: T[K] extends string ? K : never }[keyof T];

/** How to extract text from input. */
export type SectionSource =
  | { kind: "field"; inputKey: StringFields<ContextAssemblyInput>; header?: string }
  | { kind: "computed"; compute: (input: ContextAssemblyInput) => string; header?: string };

/** One entry in the section registry. */
export interface SectionDef {
  label: string;
  role: SectionRole;
  cached: boolean;
  source: SectionSource;
}

function computeThreadMetadata(input: ContextAssemblyInput): string {
  if (input.threadMetadata === undefined) return "";
  const m = input.threadMetadata;
  return [
    `Parent Chat: ${m.parentChatId}`,
    `Thread: ${m.threadId}`,
    `Starter Message: ${m.starterMessageId}`,
    `Thread Name: "${m.threadName}"`,
  ].join("\n");
}

/** Declarative section registry. Array order = output order. */
export const SECTION_DEFS: readonly SectionDef[] = [
  // Group 1: system, cached (stable identity)
  { label: "Tool Instructions",    role: "system",    cached: true,  source: { kind: "field", inputKey: "toolInstructions" } },
  { label: "Persona",              role: "system",    cached: true,  source: { kind: "field", inputKey: "persona" } },
  { label: "Instructions",         role: "system",    cached: true,  source: { kind: "field", inputKey: "instructions", header: "## Instructions" } },

  // Group 2: developer, cached (guild context + older history)
  { label: "Available Emojis",     role: "developer", cached: true,  source: { kind: "field", inputKey: "emojis", header: "## Available Emojis" } },
  { label: "Server Members",       role: "developer", cached: true,  source: { kind: "field", inputKey: "members", header: "## Server Members" } },
  { label: "Thread Metadata",      role: "developer", cached: true,  source: { kind: "computed", compute: computeThreadMetadata, header: "## Thread Metadata" } },
  { label: "Parent Pre-Context",   role: "developer", cached: true,  source: { kind: "field", inputKey: "parentPreContext" } },
  { label: "Chat History — Older", role: "developer", cached: true,  source: { kind: "field", inputKey: "olderHistory" } },

  // Group 3: developer, uncached (volatile per-message)
  { label: "Threads In This Chat", role: "developer", cached: false, source: { kind: "field", inputKey: "threadsInChat", header: "## Threads In This Chat" } },
  { label: "Upcoming Schedules",   role: "developer", cached: false, source: { kind: "field", inputKey: "upcomingSchedules", header: "## Upcoming Schedules" } },
  { label: "Journal Summaries",    role: "developer", cached: false, source: { kind: "field", inputKey: "journalSummaries", header: "## Journal" } },
  { label: "Chat History — Newer", role: "developer", cached: false, source: { kind: "field", inputKey: "newerHistory" } },
  { label: "Current Context",      role: "developer", cached: false, source: { kind: "field", inputKey: "currentContext" } },
  { label: "Late Instruction",     role: "developer", cached: false, source: { kind: "field", inputKey: "lateInstruction" } },
];

/** Assemble structured context from input sections. Empty sections are omitted. */
export function assembleContext(input: ContextAssemblyInput): AssembledContext {
  const sections: ContextSection[] = [];
  for (const def of SECTION_DEFS) {
    const raw = def.source.kind === "field"
      ? input[def.source.inputKey]
      : def.source.compute(input);
    if (raw === "") continue;
    sections.push({
      label: def.label,
      text: def.source.header !== undefined ? `${def.source.header}\n${raw}` : raw,
      cached: def.cached,
      role: def.role,
    });
  }
  return { sections, userMessage: input.userMessage };
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

/**
 * Three-way split for provider message construction.
 *
 * Sent as three separate messages to enable prefix caching:
 *   [0] role=system  (cached) — stable identity, never changes
 *   [1] role=developer (cached) — stable guild/thread context + older history
 *   [2] role=developer (uncached) — volatile channel context + recent history
 */
export interface SplitPrompts {
  /** Core instructions: tool instructions, persona, custom instructions. */
  system: string;
  /** Stable developer context: emojis, members, thread metadata, older history. */
  cachedDeveloper: string;
  /** Volatile developer context: threads list, schedules, journal, recent history, current context. */
  developer: string;
}

/**
 * Split assembled context into system / cached-developer / developer prompt strings.
 * Sections are grouped by (role, cached), preserving original order within each group.
 * Empty groups produce "".
 */
export function contextToSplitPrompts(ctx: AssembledContext): SplitPrompts {
  const system: string[] = [];
  const cachedDev: string[] = [];
  const dev: string[] = [];
  for (const s of ctx.sections) {
    if (s.role === "system") {
      system.push(s.text);
    } else if (s.cached) {
      cachedDev.push(s.text);
    } else {
      dev.push(s.text);
    }
  }
  return {
    system: system.join("\n\n"),
    cachedDeveloper: cachedDev.join("\n\n"),
    developer: dev.join("\n\n"),
  };
}
