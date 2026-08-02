import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import type { AssembledContext } from "./context-assembly.ts";
import type { LlmProvider, PromptTransportConfig, PromptTransportRole, PromptTransportSectionConfig, PromptTransportSectionId, ProviderPromptTransportConfig } from "../config/types.ts";
import type { RuntimePromptBundle } from "../config/instruction-bundle.ts";
import type { RequestLog } from "../logger.ts";
import { renderPromptTemplate } from "../config/prompt-template.ts";
import type { OpenRouterImageUrlPart, OpenRouterMessage, OpenRouterTextPart, OpenRouterToolDefinition } from "../llm/types.ts";
import { formatAssetMeta } from "./history-formatting.ts";
import { getStablePromptSections, type StablePromptSection } from "./prompt-cache.ts";
import type { IncomingMessage } from "./turn-types.ts";

export function toolToOpenRouterTool(tool: AgentTool): OpenRouterToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
    },
  };
}

export function toolContractSignature(tools: readonly AgentTool[]): string {
  return createHash("sha256")
    .update(JSON.stringify(tools.map(toolToOpenRouterTool)))
    .digest("hex");
}

export function maintenanceCacheSurface(tools: readonly AgentTool[]): string {
  const writeNames = tools
    .map((tool) => tool.name)
    .filter((name) => name.startsWith("record_"))
    .sort((a, b) => a.localeCompare(b, "en"));
  return writeNames.length > 0 ? `maintenance-${writeNames.join("-")}` : "maintenance-read-only";
}
export function buildRuntimeInstruction(runtimePrompts: RuntimePromptBundle | undefined): string {
  const external = runtimePrompts?.reply.trim() ?? "";
  if (external !== "") return external;
  return "## Runtime\nYou are present in this Discord room. Given the room state and new event, produce your next action and use tools only when useful.";
}

export function buildSkillsInstruction(runtimePrompts: RuntimePromptBundle | undefined): string {
  return runtimePrompts?.skills.indexPrompt.trim() ?? "";
}

export function buildFinalActionInstruction(runtimePrompts: RuntimePromptBundle | undefined, scheduledTaskRun = false): string {
  const base = runtimePrompts?.finalActionInstruction.trim() ?? "";
  const instruction = base !== ""
    ? base
    : "## Action Boundary\nChoose the persona's actual next move. The latest activity is context, not an assignment or mandatory subject. Emit only the chosen runtime output, without explanation.";
  const modeKey = scheduledTaskRun ? "scheduled-task-execution-mode" : "visible-reply-execution-mode";
  const externalMode = runtimePrompts?.contextTemplates[modeKey]?.trim() ?? "";
  const mode = externalMode !== ""
    ? externalMode
    : scheduledTaskRun
      ? "## Scheduled Task Context\nRun the scheduled task privately. Produce visible Discord output only when useful or requested; otherwise output <ignore>. Do not call record_memory or record_relationship here."
      : "## Actor Turn\nNormal Discord actions and private tools are available. Semantic maintenance runs separately; do not call record_memory, record_relationship, or record_inner_threads here.";
  const withMode = `${mode}\n\n${instruction}`;
  return withMode;
}

export function promptTransportForProvider(
  config: PromptTransportConfig,
  provider: LlmProvider,
): ProviderPromptTransportConfig {
  return provider === "openai-codex" ? config.openaiCodex : config.openrouter;
}

function sectionPlacement(
  transport: ProviderPromptTransportConfig,
  sectionId: PromptTransportSectionId,
): PromptTransportSectionConfig {
  return transport.sections[sectionId];
}

function stableSection(
  sectionId: PromptTransportSectionId,
  text: string,
  transport: ProviderPromptTransportConfig,
  cacheScope: StablePromptSection["cacheScope"],
): StablePromptSection {
  const placement = sectionPlacement(transport, sectionId);
  return {
    role: placement.role,
    text,
    target: placement.target,
    cacheGroup: placement.cacheGroup,
    cacheScope,
  };
}

export function sectionsForStablePrompt(
  systemPrompt: string,
  personaPrompt: string,
  stylePrompt: string,
  context: AssembledContext,
  skillsInstruction: string,
  runtimeInstruction: string,
  transport: ProviderPromptTransportConfig,
): StablePromptSection[] {
  const stable: StablePromptSection[] = [];
  if (systemPrompt !== "") stable.push(stableSection("system", systemPrompt, transport, "global"));
  if (personaPrompt !== "") stable.push(stableSection("core", personaPrompt, transport, "global"));
  if (stylePrompt !== "") stable.push(stableSection("core", stylePrompt, transport, "global"));
  if (skillsInstruction !== "") stable.push(stableSection("skills", skillsInstruction, transport, "global"));
  if (runtimeInstruction !== "") stable.push(stableSection("runtime", runtimeInstruction, transport, "global"));
  stable.push(...getStablePromptSections(
    context,
    sectionPlacement(transport, "stableContext"),
    sectionPlacement(transport, "olderHistory"),
  ));
  const customContent = sectionPlacement(transport, "custom").content ?? "";
  if (customContent.trim() !== "") {
    stable.push(stableSection("custom", customContent, transport, "global"));
  }
  return stable;
}

const codexProviderSessionIds = new Map<string, string>();

/** Build a channel-isolated provider session id for transport continuation. */
export function buildProviderSessionId(
  requestLog: RequestLog | undefined,
  provider: LlmProvider,
  modelId: string,
): string | undefined {
  if (requestLog === undefined) return undefined;
  const key = `${requestLog.guildId}:${requestLog.channelId}:${provider}:${modelId}`;
  if (provider === "openai-codex") {
    const existing = codexProviderSessionIds.get(key);
    if (existing !== undefined) return existing;
    const sessionId = Bun.randomUUIDv7();
    codexProviderSessionIds.set(key, sessionId);
    return sessionId;
  }
  const sessionId = `2b2v:${key}`;
  if (sessionId.length <= 64) return sessionId;
  return `2b2v:${createHash("sha256").update(sessionId).digest("hex").slice(0, 58)}`;
}

/** Build a stable cache-routing key for one prompt family. */
export function buildCodexPromptCacheKey(
  runtimeProfileId: string,
  modelProfileId: string,
  modelId: string,
  surface: string,
): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ runtimeProfileId, modelProfileId, modelId, surface }))
    .digest("hex");
  return `2b2v:prompt:${fingerprint.slice(0, 48)}`;
}

export interface VolatilePromptMessage {
  sectionId: PromptTransportSectionId;
  text: string;
}

const VOLATILE_SECTION_IDS_BY_LABEL: Readonly<Record<string, PromptTransportSectionId>> = {
  "Discord Context": "discordContext",
  "Upcoming Schedules": "upcomingSchedules",
  "Notebooks": "notebooks",
  "Memories": "memories",
  "Inner Threads": "innerThreads",
  "Relationships": "relationships",
  "Chat History — Newer": "recentHistory",
  "Server Members": "serverMembers",
  "Threads In This Channel": "threadsInChannel",
  "Current Context": "currentContext",
  "Persona Mode": "personaMode",
  "Private-Life Instruction": "responseInstruction",
  "Response Instruction": "responseInstruction",
};

const VOLATILE_SECTION_ORDER: readonly PromptTransportSectionId[] = [
  "discordContext",
  "serverMembers",
  "threadsInChannel",
  "upcomingSchedules",
  "notebooks",
  "innerThreads",
  "relationships",
  "memories",
  "recentHistory",
  "currentContext",
  "personaMode",
  "responseInstruction",
];

export function buildVolatileTurnMessages(context: AssembledContext): VolatilePromptMessage[] {
  const bySection = new Map<PromptTransportSectionId, string[]>();
  for (const section of context.sections) {
    if (section.cached) continue;
    const sectionId = VOLATILE_SECTION_IDS_BY_LABEL[section.label] ?? "currentContext";
    const bucket = bySection.get(sectionId);
    if (bucket === undefined) {
      bySection.set(sectionId, [section.text]);
    } else {
      bucket.push(section.text);
    }
  }

  const messages: VolatilePromptMessage[] = [];
  for (const sectionId of VOLATILE_SECTION_ORDER) {
    const texts = bySection.get(sectionId);
    if (texts === undefined || texts.length === 0) continue;
    messages.push({ sectionId, text: texts.join("\n\n") });
  }
  return messages;
}

export function initialMessageRoles(
  transport: ProviderPromptTransportConfig,
  volatileMessages: readonly VolatilePromptMessage[],
  includeFinalActionInstruction = false,
): PromptTransportRole[] {
  return [
    ...volatileMessages.map((message) => sectionPlacement(transport, message.sectionId).role),
    sectionPlacement(transport, "currentTurn").role,
    ...(includeFinalActionInstruction ? [sectionPlacement(transport, "finalActionInstruction").role] : []),
  ];
}

/** Return the stable sections that Codex should receive through top-level Responses instructions. */
export function codexSystemPromptForStableSections(
  stableSections: StablePromptSection[],
  transport: ProviderPromptTransportConfig,
): string {
  if (transport.mode === "legacy-instructions") {
    return stableSections.map((section) => section.text).join("\n\n");
  }
  return stableSections
    .filter((section) => section.target === "instructions")
    .map((section) => section.text)
    .join("\n\n");
}

function buildCurrentMessageMetadata(msg: IncomingMessage, runtimePrompts?: RuntimePromptBundle): string {
  const lines = [
    ...(msg.guildId !== undefined ? [`GuildID: ${msg.guildId}`] : []),
    ...(msg.guildName !== undefined && msg.guildName !== "" ? [`GuildName: ${msg.guildName}`] : []),
    ...(msg.channelId !== undefined ? [`ChannelID: ${msg.channelId}`] : []),
    ...(msg.channelName !== undefined && msg.channelName !== "" ? [`ChannelName: ${msg.channelName}`] : []),
    `MsgID: ${msg.messageId ?? "unknown"}`,
    `Author: @${msg.authorUsername}`,
    `AuthorID: ${msg.authorId}`,
  ];
  if (msg.authorDisplayName !== undefined && msg.authorDisplayName !== "" && msg.authorDisplayName !== msg.authorUsername) {
    lines.push(`DisplayName: ${msg.authorDisplayName}`);
  }
  if (msg.authorGlobalName !== undefined && msg.authorGlobalName !== "" && msg.authorGlobalName !== msg.authorUsername && msg.authorGlobalName !== msg.authorDisplayName) {
    lines.push(`GlobalName: ${msg.authorGlobalName}`);
  }
  if (msg.authorIsBot !== undefined) {
    lines.push(`AuthorIsBot: ${msg.authorIsBot ? "true" : "false"}`);
  }
  if (msg.replyToMessageId !== undefined) {
    lines.push(`ReplyToMsgID: ${msg.replyToMessageId}`);
  }
  if (msg.assets !== undefined) lines.push(...formatAssetMeta(msg.assets));
  if (msg.repliedToBotRouteSource !== undefined) {
    lines.push("Reply Context: The current event replies to a message you previously sent here from another channel.");
    lines.push(`Source GuildID: ${msg.repliedToBotRouteSource.sourceGuildId}`);
    lines.push(`Source ChannelID: ${msg.repliedToBotRouteSource.sourceChannelId}`);
    lines.push(`Source MsgID: ${msg.repliedToBotRouteSource.sourceMessageId}`);
    if (msg.repliedToBotRouteSource.handoff !== undefined) {
      lines.push(msg.repliedToBotRouteSource.handoff);
    }
    lines.push(runtimeContextTemplate(
      runtimePrompts,
      "routed-reply-source",
      {
        sourceGuildId: msg.repliedToBotRouteSource.sourceGuildId,
        sourceChannelId: msg.repliedToBotRouteSource.sourceChannelId,
        sourceMessageId: msg.repliedToBotRouteSource.sourceMessageId,
      },
      "Use the routed message's <handoff> to understand why it was sent and what this reply continues. If absent or insufficient, inspect the source with list_channel_messages or search_channel_messages. Do not expose source-room details unless relevant here.",
    ));
  }
  return lines.join("\n");
}

function imagePartsFromCurrentTurn(msg: IncomingMessage): OpenRouterImageUrlPart[] {
  return (msg.imageInputs ?? []).map((image) => ({
    type: "image_url",
    image_url: { url: `data:${image.contentType};base64,${image.buffer.toString("base64")}` },
  }));
}

function textPart(text: string): OpenRouterTextPart {
  return { type: "text", text };
}

export function buildInitialMessages(
  userContent: string,
  volatileMessages: readonly VolatilePromptMessage[],
  msg: IncomingMessage,
  runtimePrompts?: RuntimePromptBundle,
  roles: readonly PromptTransportRole[] = ["user"],
  finalActionInstruction = "",
): OpenRouterMessage[] {
  const roleAt = (index: number): PromptTransportRole => roles[index] ?? "user";
  const currentMessageMetadata = msg.bareCurrentTurn === true
    ? ""
    : [
        `## ${msg.eventPrompt?.metadataHeading ?? "Current Discord Message Metadata"}`,
        msg.eventPrompt?.metadataText ?? buildCurrentMessageMetadata(msg, runtimePrompts),
      ].join("\n");

  const imageMetadata = (msg.imageInputs ?? [])
    .map((image, index) => image.metadataText !== undefined && image.metadataText !== ""
      ? `Image ${index + 1}: ${image.metadataText}`
      : `Image ${index + 1}: attached to this current turn.`
    )
    .join("\n");

  const messages: OpenRouterMessage[] = [];
  for (const [index, message] of volatileMessages.entries()) {
    messages.push({
      role: roleAt(index),
      content: message.text,
    });
  }

  const text = [
      msg.currentContentInHistory === true
        ? "## Context Boundary\nThe latest available Discord activity is already included in Chat History."
        : currentMessageMetadata,
      imageMetadata !== "" ? `## Event Images\n${imageMetadata}` : "",
      msg.currentContentInHistory === true || msg.bareCurrentTurn === true
        ? ""
        : `## ${msg.eventPrompt?.contentHeading ?? "Current Discord Message"}`,
      msg.currentContentInHistory === true ? "" : msg.eventContent ?? userContent,
  ].filter((part) => part !== "").join("\n\n");
  const images = imagePartsFromCurrentTurn(msg);
  messages.push({
    role: roleAt(volatileMessages.length),
    content: images.length > 0 ? [textPart(text), ...images] : text,
  });
  if (finalActionInstruction !== "") {
    messages.push({
      role: roleAt(volatileMessages.length + 1),
      content: finalActionInstruction,
    });
  }
  return messages;
}

export function runtimeContextTemplate(
  runtimePrompts: RuntimePromptBundle | undefined,
  name: string,
  variables: Record<string, string | number | boolean | undefined>,
  fallback: string,
): string {
  const template = runtimePrompts?.contextTemplates[name];
  return template === undefined ? fallback : renderPromptTemplate(template, variables);
}

export function toolBudgetExhaustedMessage(kind: "calls" | "rounds", runtimePrompts?: RuntimePromptBundle): string {
  const label = kind === "calls" ? "tool call" : "tool round";
  return runtimeContextTemplate(
    runtimePrompts,
    "tool-budget-exhausted",
    { label },
    `Native ${label} budget exhausted before this tool could run; stop tool use.`,
  );
}

export function agentTimeBudgetExhaustedMessage(timeoutMs: number, runtimePrompts?: RuntimePromptBundle): string {
  return runtimeContextTemplate(
    runtimePrompts,
    "agent-time-budget-exhausted",
    { timeoutMs },
    `Native agent time budget exhausted after ${timeoutMs}ms; stop tool use.`,
  );
}
