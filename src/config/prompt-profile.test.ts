import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { loadPromptProfile } from "./prompt-profile.ts";
import type { Logger } from "../logger.ts";
import type { PromptProfileConfig } from "./types.ts";

const TEST_DIR = join(import.meta.dir, "../../.test-prompt-profile");

function setup() {
  mkdirSync(TEST_DIR, { recursive: true });
}

function teardown() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    logTokenUsage: () => {},
    child: () => makeLogger(),
  };
}

describe("loadPromptProfile", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("composes ordered file and inline persona/tool instruction sources", () => {
    const personaFile = join(TEST_DIR, "persona.md");
    const toolFile = join(TEST_DIR, "tool.md");
    const instructionsFile = join(TEST_DIR, "instructions.md");
    const lateInstructionsFile = join(TEST_DIR, "late-instructions.md");
    writeFileSync(personaFile, "Primary persona");
    writeFileSync(toolFile, "Primary tool instructions");
    writeFileSync(instructionsFile, "Primary instructions");
    writeFileSync(lateInstructionsFile, "Primary late instruction");

    const profile: PromptProfileConfig = {
      persona: [
        { kind: "file", path: personaFile, optional: false },
        { kind: "inline", text: "Persona addendum" },
      ],
      toolInstructions: [
        { kind: "inline", text: "Header" },
        { kind: "file", path: toolFile, optional: false },
      ],
      instructions: [
        { kind: "file", path: instructionsFile, optional: false },
        { kind: "inline", text: "Instructions addendum" },
      ],
      lateInstructions: [
        { kind: "file", path: lateInstructionsFile, optional: false },
        { kind: "inline", text: "Late addendum" },
      ],
    };

    const loaded = loadPromptProfile(profile, makeLogger());
    expect(loaded.persona).toBe("Primary persona\n\nPersona addendum");
    expect(loaded.toolInstructions).toBe("Header\n\nPrimary tool instructions");
    expect(loaded.instructions).toBe("Primary instructions\n\nInstructions addendum");
    expect(loaded.lateInstructions).toBe(
      "Primary late instruction\n\nLate addendum",
    );
  });

  test("skips missing optional file sources and keeps non-empty sources", () => {
    const toolFile = join(TEST_DIR, "tool.md");
    writeFileSync(toolFile, "Tools");

    const profile: PromptProfileConfig = {
      persona: [
        { kind: "file", path: join(TEST_DIR, "missing.md"), optional: true },
        { kind: "inline", text: "Inline persona" },
      ],
      toolInstructions: [{ kind: "file", path: toolFile, optional: false }],
      instructions: [],
      lateInstructions: [],
    };

    const loaded = loadPromptProfile(profile, makeLogger());
    expect(loaded.persona).toBe("Inline persona");
    expect(loaded.toolInstructions).toBe("Tools");
    expect(loaded.instructions).toBe("");
  });
});
