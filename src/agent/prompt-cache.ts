import type { PromptCachingConfig, PromptTransportRole, PromptTransportTarget } from "../config/types.ts";
import type { AssembledContext } from "./context-assembly.ts";

export interface StablePromptSection {
  role: PromptTransportRole;
  text: string;
  cacheGroup?: string;
  target?: PromptTransportTarget;
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

function stableInputItems(stableSections: StablePromptSection[]): Array<Record<string, unknown>> {
  const groups = stableSectionGroups(stableSections.filter((section) => (section.target ?? "input") === "input"));
  return groups.map((sections) => ({
    type: "message",
    role: sections[0]?.role ?? "developer",
    content: sections.map((section) => section.text).join("\n\n"),
  }));
}

function stableInstructions(stableSections: StablePromptSection[]): string {
  return stableSections
    .filter((section) => section.target === "instructions")
    .map((section) => section.text)
    .join("\n\n");
}

function mergeInstructionText(prefix: string, existing: unknown): string {
  const existingText = typeof existing === "string" ? existing.trim() : "";
  if (prefix === "") return existingText;
  if (existingText === "") return prefix;
  return `${prefix}\n\n${existingText}`;
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

export function getStablePromptSections(
  context: AssembledContext,
  stableContextPlacement: Pick<StablePromptSection, "role" | "target" | "cacheGroup">,
  olderHistoryPlacement: Pick<StablePromptSection, "role" | "target" | "cacheGroup">,
): StablePromptSection[] {
  return context.sections
    .filter((section) => section.cached)
    .map((section) => {
      const placement = section.label === "Chat History — Older" ? olderHistoryPlacement : stableContextPlacement;
      return {
        role: placement.role,
        text: section.text,
        target: placement.target,
        cacheGroup: placement.cacheGroup,
      };
    });
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

function applyInputRoleOverrides(input: unknown[], roles: readonly PromptTransportRole[]): void {
  if (roles.length === 0) return;
  let roleIndex = 0;
  for (const item of input) {
    if (roleIndex >= roles.length) return;
    if (!isRecord(item)) continue;
    const type = item.type;
    if (type !== undefined && type !== "message") continue;
    if (item.role !== "user" && item.role !== "developer" && item.role !== "system") continue;
    item.role = roles[roleIndex];
    roleIndex += 1;
  }
}

/** Mutate a Codex Responses payload by prepending stable input messages. */
export function prependStableSectionsToCodexPayload(
  payload: unknown,
  stableSections: StablePromptSection[],
  currentInputRoles: readonly PromptTransportRole[],
): void {
  if (!isRecord(payload)) return;
  const input = payload.input;
  if (!Array.isArray(input)) return;

  applyInputRoleOverrides(input, currentInputRoles);

  const instructionPrefix = stableInstructions(stableSections);
  payload.instructions = mergeInstructionText(instructionPrefix, payload.instructions);

  const toInsert = stableInputItems(stableSections);
  if (toInsert.length > 0) {
    input.unshift(...toInsert);
  }
}
