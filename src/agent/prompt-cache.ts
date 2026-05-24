import type { PromptCachingConfig } from "../config/types.ts";
import type { AssembledContext } from "./context-assembly.ts";

export interface StablePromptSection {
  role: "system" | "developer";
  text: string;
}

interface StablePromptGroup {
  role: "system" | "developer";
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function makePromptContent(
  text: string,
  withCacheControl: boolean,
): string | Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> {
  if (!withCacheControl) return text;
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
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

function groupStableSections(stableSections: StablePromptSection[]): StablePromptGroup[] {
  const groups = new Map<string, StablePromptGroup>();
  for (const section of stableSections) {
    const key = `${section.role}:cached`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { role: section.role, text: section.text });
      continue;
    }
    existing.text = `${existing.text}\n\n${section.text}`;
  }
  return [...groups.values()];
}

export function getStablePromptSections(context: AssembledContext): StablePromptSection[] {
  return context.sections
    .filter((section) => section.cached)
    .map((section) => ({ role: section.role, text: section.text }));
}

/**
 * Mutate an OpenAI-compatible payload by prepending grouped stable context sections.
 * Stable sections are merged by (role, cached) buckets and keep original order within each bucket.
 */
export function prependStableSectionsToPayload(
  payload: unknown,
  stableSections: StablePromptSection[],
  promptCaching: PromptCachingConfig,
): void {
  if (!isRecord(payload)) return;
  const messages = payload.messages;
  if (!Array.isArray(messages)) return;

  if (promptCaching.enabled) stripCacheControlFromMessages(messages);

  const stableGroups = groupStableSections(stableSections);
  const toInsert = stableGroups.map((group, idx) => ({
    role: group.role,
    content: makePromptContent(group.text, promptCaching.enabled && idx === 0),
  }));
  if (toInsert.length > 0) {
    messages.unshift(...toInsert);
  }
}
