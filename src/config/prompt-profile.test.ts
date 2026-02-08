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
    writeFileSync(personaFile, "Primary persona");
    writeFileSync(toolFile, "Primary tool instructions");

    const profile: PromptProfileConfig = {
      persona: [
        { kind: "file", path: personaFile, optional: false },
        { kind: "inline", text: "Persona addendum" },
      ],
      toolInstructions: [
        { kind: "inline", text: "Header" },
        { kind: "file", path: toolFile, optional: false },
      ],
    };

    const loaded = loadPromptProfile(profile, makeLogger());
    expect(loaded.persona).toBe("Primary persona\n\nPersona addendum");
    expect(loaded.toolInstructions).toBe("Header\n\nPrimary tool instructions");
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
    };

    const loaded = loadPromptProfile(profile, makeLogger());
    expect(loaded.persona).toBe("Inline persona");
    expect(loaded.toolInstructions).toBe("Tools");
  });
});
