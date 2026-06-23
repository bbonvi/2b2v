import type { PromptCachingConfig } from "../config/types.ts";
import type { AssembledContext } from "./context-assembly.ts";

export interface StablePromptSection {
  role: "system" | "developer";
  text: string;
  cacheGroup?: string;
}

interface PromptTextPart {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function stripCacheControlFromMessages(messages: unknown[]): void {
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      if ("cache_control" in part) {
        delete part.cache_control;
      }
    }
  }
}

function stableSectionGroups(stableSections: StablePromptSection[]): StablePromptSection[][] {
  const groups: StablePromptSection[][] = [];
  for (const section of stableSections) {
    const last = groups.at(-1);
    const first = last?.[0];
    if (
      last !== undefined
      && first !== undefined
      && first.role === section.role
      && (first.cacheGroup ?? "") === (section.cacheGroup ?? "")
    ) {
      last.push(section);
      continue;
    }
    groups.push([section]);
  }
  return groups;
}

function buildMergedContent(
  sections: StablePromptSection[],
  explicitCache: boolean,
): string | PromptTextPart[] {
  const text = sections.map((section) => section.text).join("\n\n");
  if (!explicitCache) {
    return text;
  }

  return [{
    type: "text",
    text,
    cache_control: { type: "ephemeral" },
  }];
}

function buildStableMessages(
  stableSections: StablePromptSection[],
  explicitCache: boolean,
): Array<Record<string, unknown>> {
  const groups = stableSectionGroups(stableSections);
  return groups.map((sections) => ({
    role: sections[0]?.role ?? "system",
    content: buildMergedContent(sections, explicitCache),
  }));
}

function buildCacheAnchorMessages(promptCaching: PromptCachingConfig): Array<Record<string, unknown>> {
  if (!promptCaching.enabled) return [];
  return [
    {
      role: "user",
      content: "Stable context is loaded; wait for the current Discord turn.",
    },
    {
      role: "assistant",
      content: "Ready.",
    },
  ];
}

export function getStablePromptSections(context: AssembledContext): StablePromptSection[] {
  return context.sections
    .filter((section) => section.cached)
    .map((section) => ({
      role: section.role,
      text: section.text,
      cacheGroup: section.label === "Chat History — Older" ? "older-history" : "stable-context",
    }));
}

/**
 * Mutate an OpenAI-compatible payload by prepending grouped stable context sections.
 * Stable sections are merged by role, and volatile context must remain after
 * the stable anchor so provider-side prefix caches keep a consistent start.
 */
export function prependStableSectionsToPayload(
  payload: unknown,
  stableSections: StablePromptSection[],
  promptCaching: PromptCachingConfig,
  _model?: string,
): void {
  if (!isRecord(payload)) return;
  const messages = payload.messages;
  if (!Array.isArray(messages)) return;

  stripCacheControlFromMessages(messages);

  const explicitCache = promptCaching.enabled;
  const toInsert = [
    ...buildStableMessages(stableSections, explicitCache),
    ...buildCacheAnchorMessages(promptCaching),
  ];
  if (toInsert.length > 0) {
    messages.unshift(...toInsert);
  }
}
