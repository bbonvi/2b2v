import { describe, test, expect } from "bun:test";
import {
  assembleContext,
  contextToSystemPrompt,
  SECTION_DEFS,
  type ContextAssemblyInput,
} from "./context-assembly.ts";

function makeInput(overrides: Partial<ContextAssemblyInput> = {}): ContextAssemblyInput {
  return {
    toolInstructions: "## Tool Guidance\nUse tools only when useful.",
    instructions: "",
    emojis: ":wave: — custom emoji",
    members: "@alice — Alice\n@bob — Bob",
    memories: "- User likes cats",
    upcomingSchedules: "- [cron UTC] 0 9 * * *: Good morning",
    threadsInChat: "",
    parentPreContext: "",
    olderHistory: "## Chat History (Older)\nLegend: ...\n[@alice]: hello",
    newerHistory: "## Chat History (Recent)\n[@bob]: hi there",
    currentContext: "Guild: g1 | Channel: c1\nDate/Time: 2026-01-01T00:00:00Z",
    responseInstruction: "",
    userMessage: "[@carol]: what's up?",
    ...overrides,
  };
}

describe("SECTION_DEFS", () => {
  test("all labels are unique", () => {
    const labels = SECTION_DEFS.map((d) => d.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("system sections form a contiguous prefix", () => {
    const roles = SECTION_DEFS.map((d) => d.role);
    const lastSystemIdx = roles.lastIndexOf("system");
    const firstDevIdx = roles.indexOf("developer");
    expect(lastSystemIdx).toBeLessThan(firstDevIdx);
  });

  test("all system sections are cached", () => {
    const systemDefs = SECTION_DEFS.filter((d) => d.role === "system");
    expect(systemDefs.length).toBeGreaterThan(0);
    for (const d of systemDefs) {
      expect(d.cached).toBe(true);
    }
  });

  test("stable context sections are system role", () => {
    const labels = SECTION_DEFS
      .filter((d) => d.role === "system")
      .map((d) => d.label);
    expect(labels).toEqual([
      "Tool Instructions",
      "Instructions",
      "Available Emojis",
      "Thread Metadata",
      "Parent Pre-Context",
      "Chat History — Older",
    ]);
  });

  test("within developer sections, cached precede uncached (contiguous groups)", () => {
    const devDefs = SECTION_DEFS.filter((d) => d.role === "developer");
    const cachedFlags = devDefs.map((d) => d.cached);
    const lastCachedIdx = cachedFlags.lastIndexOf(true);
    const firstUncachedIdx = cachedFlags.indexOf(false);
    // All cached developer sections come before all uncached developer sections
    if (lastCachedIdx !== -1 && firstUncachedIdx !== -1) {
      expect(lastCachedIdx).toBeLessThan(firstUncachedIdx);
    }
  });

  test("every field source references a valid string key of ContextAssemblyInput", () => {
    // Build the set of string keys from a dummy input
    const dummy = makeInput();
    const stringKeys = new Set(
      Object.entries(dummy)
        .filter(([_k, v]) => typeof v === "string")
        .map(([k]) => k)
    );
    for (const def of SECTION_DEFS) {
      if (def.source.kind === "field") {
        expect(stringKeys.has(def.source.inputKey)).toBe(true);
      }
    }
  });

  test("Thread Metadata is the only computed section", () => {
    const computed = SECTION_DEFS.filter((d) => d.source.kind === "computed");
    expect(computed).toHaveLength(1);
    expect(computed[0]?.label).toBe("Thread Metadata");
  });

  test("Response Instruction is the last section", () => {
    expect(SECTION_DEFS[SECTION_DEFS.length - 1]?.label).toBe("Response Instruction");
  });
});

describe("assembleContext", () => {
  test("produces all 8 sections when all inputs present (no instructions)", () => {
    const result = assembleContext(makeInput());
    expect(result.sections).toHaveLength(8);
  });

  test("produces 9 sections when instructions present", () => {
    const result = assembleContext(makeInput({ instructions: "Be concise and helpful." }));
    expect(result.sections).toHaveLength(9);
    const labels = result.sections.map((s) => s.label);
    expect(labels).toContain("Instructions");
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
        memories: "",
        upcomingSchedules: "",
        olderHistory: "",
      })
    );
    const labels = result.sections.map((s) => s.label);
    expect(labels).toEqual([
      "Tool Instructions",
      "Chat History — Newer",
      "Current Context",
    ]);
  });

  test("cached/uncached grouping matches SECTION_DEFS", () => {
    const result = assembleContext(makeInput({ instructions: "test" }));
    const cachedLabels = result.sections
      .filter((s) => s.cached)
      .map((s) => s.label);
    expect(cachedLabels).toEqual([
      "Tool Instructions",
      "Instructions",
      "Available Emojis",
      "Chat History — Older",
    ]);
    const uncachedLabels = result.sections
      .filter((s) => !s.cached)
      .map((s) => s.label);
    expect(uncachedLabels).toEqual([
      "Server Members",
      "Upcoming Schedules",
      "Memories",
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

  test("wraps memories with section header", () => {
    const result = assembleContext(makeInput({ memories: "- Entry one" }));
    const section = result.sections.find((s) => s.label === "Memories");
    expect(section?.text).toBe("## Memory\n- Entry one");
  });

  test("wraps schedules with section header", () => {
    const result = assembleContext(
      makeInput({ upcomingSchedules: "- [one-off at 2026-01-01] hello" })
    );
    const section = result.sections.find((s) => s.label === "Upcoming Schedules");
    expect(section?.text).toBe("## Upcoming Schedules\n- [one-off at 2026-01-01] hello");
  });

  test("wraps threads in chat with section header and marks it uncached", () => {
    const result = assembleContext(
      makeInput({ threadsInChat: '- "Help Thread" (thread_id: 123) — 5 msgs, 2h ago' })
    );
    const section = result.sections.find((s) => s.label === "Threads In This Chat");
    expect(section?.text).toBe('## Threads In This Chat\n- "Help Thread" (thread_id: 123) — 5 msgs, 2h ago');
    expect(section?.cached).toBe(false);
  });

  test("thread metadata section is cached and has correct format", () => {
    const result = assembleContext(
      makeInput({
        threadMetadata: {
          parentChatId: "parent-123",
          threadId: "thread-456",
          starterMessageId: "msg-789",
          threadName: "Help Discussion",
        },
      })
    );
    const section = result.sections.find((s) => s.label === "Thread Metadata");
    expect(section).toBeDefined();
    expect(section?.cached).toBe(true);
    expect(section?.text).toBe(
      "## Thread Metadata\n" +
      "Parent Chat: parent-123\n" +
      "Thread: thread-456\n" +
      "Starter Message: msg-789\n" +
      'Thread Name: "Help Discussion"'
    );
  });

  test("thread metadata is omitted when undefined", () => {
    const result = assembleContext(makeInput({ threadMetadata: undefined }));
    const labels = result.sections.map((s) => s.label);
    expect(labels).not.toContain("Thread Metadata");
  });

  test("parent pre-context section is cached and appears before older history", () => {
    const result = assembleContext(
      makeInput({
        parentPreContext: "## Parent Pre-Context\n[@alice]: context from parent",
        olderHistory: "## Chat History (Older)\nhello",
      })
    );
    const section = result.sections.find((s) => s.label === "Parent Pre-Context");
    expect(section).toBeDefined();
    expect(section?.cached).toBe(true);
    expect(section?.text).toBe("## Parent Pre-Context\n[@alice]: context from parent");

    const labels = result.sections.map((s) => s.label);
    const preCtxIdx = labels.indexOf("Parent Pre-Context");
    const olderIdx = labels.indexOf("Chat History — Older");
    expect(preCtxIdx).toBeLessThan(olderIdx);
  });

  test("parent pre-context is omitted when empty", () => {
    const result = assembleContext(makeInput({ parentPreContext: "" }));
    const labels = result.sections.map((s) => s.label);
    expect(labels).not.toContain("Parent Pre-Context");
  });

  test("thread context has correct section order", () => {
    const result = assembleContext(
      makeInput({
        upcomingSchedules: "- schedule",
        threadMetadata: {
          parentChatId: "p1",
          threadId: "t1",
          starterMessageId: "m1",
          threadName: "Thread",
        },
        parentPreContext: "## Parent Pre-Context\nparent messages",
        olderHistory: "## Chat History (Older)\nthread history",
        newerHistory: "## Chat History (Recent)\nrecent thread",
      })
    );
    const labels = result.sections.map((s) => s.label);

    // Thread Metadata < Parent Pre-Context < Older < Schedules < Newer
    const metaIdx = labels.indexOf("Thread Metadata");
    const preCtxIdx = labels.indexOf("Parent Pre-Context");
    const olderIdx = labels.indexOf("Chat History — Older");
    const schedulesIdx = labels.indexOf("Upcoming Schedules");
    const newerIdx = labels.indexOf("Chat History — Newer");

    expect(metaIdx).toBeLessThan(preCtxIdx);
    expect(preCtxIdx).toBeLessThan(olderIdx);
    expect(olderIdx).toBeLessThan(schedulesIdx);
    expect(schedulesIdx).toBeLessThan(newerIdx);
  });

  test("tool instructions pass through without extra wrapping", () => {
    const result = assembleContext(makeInput());
    expect(result.sections.map((s) => s.label)).not.toContain("Persona");
    const tools = result.sections.find((s) => s.label === "Tool Instructions");
    expect(tools?.text).toBe("## Tool Guidance\nUse tools only when useful.");
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

  test("all sections omitted except tool instructions when everything else empty", () => {
    const result = assembleContext(
      makeInput({
        toolInstructions: "Use tools only when useful.",
        instructions: "",
        emojis: "",
        members: "",
        memories: "",
        upcomingSchedules: "",
        olderHistory: "",
        newerHistory: "",
        currentContext: "",
      })
    );
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]).toBeDefined();
    expect(result.sections[0]?.label).toBe("Tool Instructions");
  });

  test("empty tool instructions are omitted too", () => {
    const result = assembleContext(
      makeInput({
        toolInstructions: "",
        instructions: "",
        emojis: "",
        members: "",
        memories: "",
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
      memories: "",
      upcomingSchedules: "",
      olderHistory: "",
      newerHistory: "",
    }));
    const prompt = contextToSystemPrompt(ctx);
    expect(prompt).toBe(
      "## Tool Guidance\nUse tools only when useful.\n\n" +
      "Guild: g1 | Channel: c1\nDate/Time: 2026-01-01T00:00:00Z"
    );
  });

  test("returns empty string when no sections", () => {
    const ctx = assembleContext(makeInput({
      toolInstructions: "",
      instructions: "",
      emojis: "",
      members: "",
      memories: "",
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
    // Tool instructions (stable) must appear before Current Context (unstable)
    const personaIdx = prompt.indexOf("## Tool Guidance");
    const contextIdx = prompt.indexOf("Guild: g1 | Channel: c1");
    expect(personaIdx).toBeLessThan(contextIdx);
  });

  test("instructions section appears between tool instructions and emojis", () => {
    const ctx = assembleContext(makeInput({ instructions: "Be brief." }));
    const prompt = contextToSystemPrompt(ctx);
    const toolIdx = prompt.indexOf("## Tool Guidance");
    const instrIdx = prompt.indexOf("## Instructions\nBe brief.");
    const emojiIdx = prompt.indexOf("## Available Emojis");
    expect(toolIdx).toBeLessThan(instrIdx);
    expect(instrIdx).toBeLessThan(emojiIdx);
  });

  test("response instruction appears after current context", () => {
    const ctx = assembleContext(makeInput({
      responseInstruction: "Answer in one sentence.",
    }));
    const prompt = contextToSystemPrompt(ctx);
    const contextIdx = prompt.indexOf("Guild: g1 | Channel: c1");
    const lateIdx = prompt.indexOf("Answer in one sentence.");
    expect(contextIdx).toBeGreaterThan(-1);
    expect(lateIdx).toBeGreaterThan(-1);
    expect(lateIdx).toBeGreaterThan(contextIdx);
  });

  test("response instruction is omitted when empty", () => {
    const ctx = assembleContext(makeInput({ responseInstruction: "" }));
    const labels = ctx.sections.map((s) => s.label);
    expect(labels).not.toContain("Response Instruction");
  });
});
