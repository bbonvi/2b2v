import { existsSync, readFileSync } from "fs";
import type { Logger } from "../logger.ts";
import type { PromptProfileConfig, PromptSource } from "./types.ts";

export type PromptProfileSection = "persona" | "toolInstructions" | "instructions";

export interface LoadedPromptProfile {
  persona: string;
  toolInstructions: string;
  instructions: string;
}

function loadSourceText(
  source: PromptSource,
  section: PromptProfileSection,
  index: number,
  log: Logger,
): string {
  if (source.kind === "inline") {
    return source.text.trim();
  }

  const path = source.path;
  if (path === "") {
    log.warn("prompt profile source has empty file path", { section, index });
    return "";
  }
  if (!existsSync(path)) {
    if (source.optional) {
      log.info("optional prompt profile source missing, skipping", { section, index, path });
    } else {
      log.warn("prompt profile source missing, skipping", { section, index, path });
    }
    return "";
  }

  const text = readFileSync(path, "utf-8").trim();
  log.info("prompt profile source loaded", { section, index, path, length: text.length });
  return text;
}

export function loadPromptSourceChain(
  sources: PromptSource[],
  section: PromptProfileSection,
  log: Logger,
): string {
  const parts: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    if (source === undefined) continue;
    const text = loadSourceText(source, section, i, log);
    if (text !== "") parts.push(text);
  }
  return parts.join("\n\n");
}

export function loadPromptProfile(
  profile: PromptProfileConfig,
  log: Logger,
): LoadedPromptProfile {
  return {
    persona: loadPromptSourceChain(profile.persona, "persona", log),
    toolInstructions: loadPromptSourceChain(profile.toolInstructions, "toolInstructions", log),
    instructions: loadPromptSourceChain(profile.instructions, "instructions", log),
  };
}
