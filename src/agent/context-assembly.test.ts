import { describe, test, expect } from "bun:test";
import {
  assembleContext,
  contextToSystemPrompt,
  type ContextAssemblyInput,
} from "./context-assembly.ts";

function makeInput(overrides: Partial<ContextAssemblyInput> = {}): ContextAssemblyInput {
  return {
    persona: "You are a test bot.",
    toolInstructions: "## How You Communicate\nUse send_message.",
    instructions: "",
    emojis: ":wave: — custom emoji",
    members: "@alice — Alice\n@bob — Bob",
    journalSummaries: "- User likes cats",
    upcomingSchedules: "- [cron UTC] 0 9 * * *: Good morning",
    threadsInChat: "",
    olderHistory: "## Chat History (Older)\nLegend: ...\n[@alice]: hello",
    newerHistory: "## Chat History (Recent)\n[@bob]: hi there",
    currentContext: "Guild: g1 | Channel: c1\nDate/Time: 2026-01-01T00:00:00Z",
    lateInstruction: "",
    userMessage: "[@carol]: what's up?",
    ...overrides,
  };
}

describe("assembleContext", () => {
  test("produces all 9 sections in correct order when all inputs present (no instructions)", () => {
    const result = assembleContext(makeInput());
    expect(result.sections).toHaveLength(9);
    const labels = result.sections.map((s) => s.label);
    expect(labels).toEqual([
      "Persona",
      "Tool Instructions",
      "Available Emojis",
      "Server Members",
      "Upcoming Schedules",
      "Chat History — Older",
      "Journal Summaries",
      "Chat History — Newer",
      "Current Context",
    ]);
  });

  test("produces 10 sections when instructions present", () => {
    const result = assembleContext(makeInput({ instructions: "Be concise and helpful." }));
    expect(result.sections).toHaveLength(10);
    const labels = result.sections.map((s) => s.label);
    expect(labels).toEqual([
      "Persona",
      "Tool Instructions",
      "Instructions",
      "Available Emojis",
      "Server Members",
      "Upcoming Schedules",
      "Chat History — Older",
      "Journal Summaries",
      "Chat History — Newer",
      "Current Context",
    ]);
  });

  test("instructions section is cached and has header", () => {
    const result = assembleContext(makeInput({ instructions: "Custom instructions" }));
    const section = result.sections.find((s) => s.label === "Instructions");
    expect(section).toBeDefined();
    expect(section?.cached).toBe(true);
    expect(section?.text).toBe("## Instructions\nCustom instructions");
  });

  test("returns userMessage separately from sections", () => {
    const result = assembleContext(makeInput());
    expect(result.userMessage).toBe("[@carol]: what's up?");
  });

  test("omits empty sections", () => {
    const result = assembleContext(
      makeInput({
        emojis: "",
        members: "",
        journalSummaries: "",
        upcomingSchedules: "",
        olderHistory: "",
      })
    );
    const labels = result.sections.map((s) => s.label);
    expect(labels).toEqual([
      "Persona",
      "Tool Instructions",
      "Chat History — Newer",
      "Current Context",
    ]);
  });

  test("marks stable sections as cached", () => {
    const result = assembleContext(makeInput({ instructions: "test" }));
    const cachedLabels = result.sections
      .filter((s) => s.cached)
      .map((s) => s.label);
    expect(cachedLabels).toEqual([
      "Persona",
      "Tool Instructions",
      "Instructions",
      "Available Emojis",
      "Server Members",
      "Upcoming Schedules",
      "Chat History — Older",
    ]);
  });

  test("marks newer history and current context as uncached", () => {
    const result = assembleContext(makeInput());
    const uncachedLabels = result.sections
      .filter((s) => !s.cached)
      .map((s) => s.label);
    expect(uncachedLabels).toEqual([
      "Journal Summaries",
      "Chat History — Newer",
      "Current Context",
    ]);
  });

  test("wraps emojis with section header", () => {
    const result = assembleContext(makeInput({ emojis: ":fire: — custom emoji" }));
    const emojiSection = result.sections.find((s) => s.label === "Available Emojis");
    expect(emojiSection?.text).toBe("## Available Emojis\n:fire: — custom emoji");
  });

  test("wraps members with section header", () => {
    const result = assembleContext(makeInput({ members: "@dan — Dan" }));
    const memberSection = result.sections.find((s) => s.label === "Server Members");
    expect(memberSection?.text).toBe("## Server Members\n@dan — Dan");
  });

  test("wraps journal summaries with section header", () => {
    const result = assembleContext(makeInput({ journalSummaries: "- Entry one" }));
    const section = result.sections.find((s) => s.label === "Journal Summaries");
    expect(section?.text).toBe("## Journal\n- Entry one");
  });

  test("wraps schedules with section header", () => {
    const result = assembleContext(
      makeInput({ upcomingSchedules: "- [one-off at 2026-01-01] hello" })
    );
    const section = result.sections.find((s) => s.label === "Upcoming Schedules");
    expect(section?.text).toBe("## Upcoming Schedules\n- [one-off at 2026-01-01] hello");
  });

  test("wraps threads in chat with section header and is uncached", () => {
    const result = assembleContext(
      makeInput({ threadsInChat: '- "Help Thread" (thread_id: 123) — 5 msgs, 2h ago' })
    );
    const section = result.sections.find((s) => s.label === "Threads In This Chat");
    expect(section?.text).toBe('## Threads In This Chat\n- "Help Thread" (thread_id: 123) — 5 msgs, 2h ago');
    expect(section?.cached).toBe(false);
  });

  test("threads in chat section appears after schedules and before older history", () => {
    const result = assembleContext(
      makeInput({
        upcomingSchedules: "- schedule",
        threadsInChat: "- thread",
        olderHistory: "## Chat History (Older)\nhello",
      })
    );
    const labels = result.sections.map((s) => s.label);
    const schedulesIdx = labels.indexOf("Upcoming Schedules");
    const threadsIdx = labels.indexOf("Threads In This Chat");
    const olderIdx = labels.indexOf("Chat History — Older");
    expect(threadsIdx).toBeGreaterThan(schedulesIdx);
    expect(threadsIdx).toBeLessThan(olderIdx);
  });

  test("persona and tool instructions pass through without extra wrapping", () => {
    const result = assembleContext(makeInput());
    const persona = result.sections.find((s) => s.label === "Persona");
    expect(persona?.text).toBe("You are a test bot.");
    const tools = result.sections.find((s) => s.label === "Tool Instructions");
    expect(tools?.text).toBe("## How You Communicate\nUse send_message.");
  });

  test("older and newer history pass through without extra wrapping", () => {
    const result = assembleContext(makeInput());
    const older = result.sections.find((s) => s.label === "Chat History — Older");
    expect(older?.text).toContain("Chat History (Older)");
    const newer = result.sections.find((s) => s.label === "Chat History — Newer");
    expect(newer?.text).toContain("Chat History (Recent)");
  });

  test("deterministic output for identical inputs", () => {
    const input = makeInput();
    const a = assembleContext(input);
    const b = assembleContext(input);
    expect(a).toEqual(b);
  });

  test("all sections omitted except persona when everything else empty", () => {
    const result = assembleContext(
      makeInput({
        toolInstructions: "",
        instructions: "",
        emojis: "",
        members: "",
        journalSummaries: "",
        upcomingSchedules: "",
        olderHistory: "",
        newerHistory: "",
        currentContext: "",
      })
    );
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]).toBeDefined();
    expect(result.sections[0]?.label).toBe("Persona");
  });

  test("empty persona is omitted too", () => {
    const result = assembleContext(
      makeInput({
        persona: "",
        toolInstructions: "",
        instructions: "",
        emojis: "",
        members: "",
        journalSummaries: "",
        upcomingSchedules: "",
        olderHistory: "",
        newerHistory: "",
        currentContext: "",
      })
    );
    expect(result.sections).toHaveLength(0);
  });
});

describe("contextToSystemPrompt", () => {
  test("joins sections with double newline", () => {
    const ctx = assembleContext(makeInput({
      emojis: "",
      members: "",
      journalSummaries: "",
      upcomingSchedules: "",
      olderHistory: "",
      newerHistory: "",
    }));
    const prompt = contextToSystemPrompt(ctx);
    expect(prompt).toBe(
      "You are a test bot.\n\n" +
      "## How You Communicate\nUse send_message.\n\n" +
      "Guild: g1 | Channel: c1\nDate/Time: 2026-01-01T00:00:00Z"
    );
  });

  test("returns empty string when no sections", () => {
    const ctx = assembleContext(makeInput({
      persona: "",
      toolInstructions: "",
      instructions: "",
      emojis: "",
      members: "",
      journalSummaries: "",
      upcomingSchedules: "",
      olderHistory: "",
      newerHistory: "",
      currentContext: "",
    }));
    expect(contextToSystemPrompt(ctx)).toBe("");
  });

  test("stable sections precede unstable sections in output", () => {
    const ctx = assembleContext(makeInput());
    const prompt = contextToSystemPrompt(ctx);
    // Persona (stable) must appear before Current Context (unstable)
    const personaIdx = prompt.indexOf("You are a test bot.");
    const contextIdx = prompt.indexOf("Guild: g1 | Channel: c1");
    expect(personaIdx).toBeLessThan(contextIdx);
  });

  test("instructions section appears between tool instructions and emojis", () => {
    const ctx = assembleContext(makeInput({ instructions: "Be brief." }));
    const prompt = contextToSystemPrompt(ctx);
    const toolIdx = prompt.indexOf("## How You Communicate");
    const instrIdx = prompt.indexOf("## Instructions\nBe brief.");
    const emojiIdx = prompt.indexOf("## Available Emojis");
    expect(toolIdx).toBeLessThan(instrIdx);
    expect(instrIdx).toBeLessThan(emojiIdx);
  });

  test("late instruction appears after current context", () => {
    const ctx = assembleContext(makeInput({
      lateInstruction: "Always call start_typing before send_message.",
    }));
    const prompt = contextToSystemPrompt(ctx);
    const contextIdx = prompt.indexOf("Guild: g1 | Channel: c1");
    const lateIdx = prompt.indexOf("Always call start_typing before send_message.");
    expect(contextIdx).toBeGreaterThan(-1);
    expect(lateIdx).toBeGreaterThan(-1);
    expect(lateIdx).toBeGreaterThan(contextIdx);
  });

  test("late instruction is omitted when empty", () => {
    const ctx = assembleContext(makeInput({ lateInstruction: "" }));
    const labels = ctx.sections.map((s) => s.label);
    expect(labels).not.toContain("Late Instruction");
  });
});
