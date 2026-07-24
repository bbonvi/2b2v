import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { shouldRespond, type TriggerInput, type TriggerResult } from "./triggers.ts";
import type { AssembledContext } from "./context-assembly.ts";
import { wrapToolsWithTiming, type TimingState } from "./tool-timing.ts";
import type {
  LlmProvider,
  PromptCachingConfig,
  PromptTransportConfig,
  PromptTransportRole,
  PromptTransportSectionConfig,
  PromptTransportSectionId,
  ProviderPromptTransportConfig,
} from "../config/types.ts";
import type { TtsResult } from "../tts/types.ts";
import {
  buildModelProfileStreamOptions,
  resolveModelProfile,
  resolveModelProfileModel,
  type ModelImageInputSupport,
} from "../llm/client.ts";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";
import type { Logger, RequestLog } from "../logger.ts";
import { completeLlmChat } from "../llm/chat.ts";
import { ModelProviderError } from "../llm/codex-chat.ts";
import type {
  OpenRouterChatRequest,
  OpenRouterChatResult,
  OpenRouterImageUrlPart,
  OpenRouterMessage,
  OpenRouterTextPart,
  OpenRouterToolCall,
  OpenRouterToolDefinition,
} from "../llm/types.ts";
import {
  getStablePromptSections,
  prependStableSectionsToCodexPayload,
  prependStableSectionsToPayload,
  type StablePromptSection,
} from "./prompt-cache.ts";
import {
  parseResponseDirectives,
  renderSegmentsForMemory,
  type MessageDelivery,
  type ResponseSegment,
} from "./response-directives.ts";
import { currentLocalContext } from "../time/agent-time.ts";
import type { RuntimePromptBundle } from "../config/instruction-bundle.ts";
import { renderPromptTemplate } from "../config/prompt-template.ts";
import { createLoadSkillTool } from "./load-skill-tool.ts";
import { typingSimulationDelayMs } from "./typing-simulation.ts";
import { formatAssetMeta } from "./history-formatting.ts";
import type { HistoryAsset } from "./history-types.ts";
import type { AssetRef } from "./asset-id.ts";
import { OutboundXmlTagError } from "../discord/outbound-xml-guard.ts";

/** Minimal abstraction over a Discord message for the handler. */
export interface IncomingMessage {
  content: string;
  guildId?: string;
  guildName?: string;
  channelId?: string;
  channelName?: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName?: string;
  authorGlobalName?: string;
  authorIsBot?: boolean;
  botUserId: string;
  mentionedUserIds: string[];
  mentionedRoleIds: string[];
  botRoleIds: string[];
  mentionedEveryone: boolean;
  translatedContent: string;
  /** The canonical chat-history section already contains this Discord content. */
  currentContentInHistory?: boolean;
  /** Full visible current-turn event text, including debounced same-author followups. */
  eventContent?: string;
  /** Voice and other non-message turns can replace Discord-message prompt headings. */
  eventPrompt?: {
    metadataHeading: string;
    contentHeading: string;
    metadataText?: string;
  };
  messageId?: string;
  replyToMessageId?: string;
  repliedToBot?: boolean;
  repliedToBotRouteSource?: {
    sourceGuildId: string;
    sourceChannelId: string;
    sourceMessageId: string;
  };
  imageInputs?: CurrentTurnImageInput[];
  /** Lazy assets attached to the current Discord event. */
  assets?: HistoryAsset[];
}

export type ChatCompleteFn = (request: OpenRouterChatRequest) => Promise<OpenRouterChatResult>;

export interface MaintenancePromptContext {
  provider: LlmProvider;
  model: string;
  transport: ProviderPromptTransportConfig;
  stableSections: StablePromptSection[];
  initialRoles: PromptTransportRole[];
  sessionId?: string;
  promptCacheKey?: string;
  promptCaching: PromptCachingConfig;
  /** Exact provider-visible tool contract from the actor turn that maintenance must preserve. */
  toolContractSignature?: string;
}

export interface MemoryExtractionRequest {
  sourceMessageId?: string;
  userMessage: string;
  assistantReply: string;
  recentContext: string;
  context: AssembledContext;
  incomingMessage: IncomingMessage;
  visibleReplySent: boolean;
  maintenanceTranscript?: OpenRouterMessage[];
  availableTools?: AgentTool[];
  promptContext?: MaintenancePromptContext;
}

export interface IgnoredReplyRequest {
  sourceMessageId?: string;
  channelId?: string;
  historyText: string;
  rawResponse: string;
}

/** Return true when a completed turn has enough material for maintenance passes. */
export function hasMaintenanceMaterial(input: Pick<MemoryExtractionRequest, "userMessage" | "assistantReply">): boolean {
  return input.userMessage.trim() !== "" || input.assistantReply.trim() !== "";
}

export interface SilentMemoryAgentInput {
  globalConfig: GlobalConfig;
  guildConfig: GuildConfig;
  context: AssembledContext;
  systemPrompt?: string;
  personaPrompt?: string;
  runtimePrompts?: RuntimePromptBundle;
  incomingMessage: IncomingMessage;
  userContent: string;
  assistantReply: string;
  visibleReplySent: boolean;
  passKind?: "post_reply" | "ambient";
  visibleUserMemoryContext?: string;
  tools: AgentTool[];
  transcript?: OpenRouterMessage[];
  promptContext?: MaintenancePromptContext;
  log?: Logger;
  requestLog?: RequestLog;
  completeChat?: ChatCompleteFn;
  signal?: AbortSignal;
  /** Cache the current pass input because another maintenance pass will consume it. */
}

export interface SilentToolAgentInput {
  globalConfig: GlobalConfig;
  guildConfig: GuildConfig;
  context: AssembledContext;
  systemPrompt?: string;
  personaPrompt?: string;
  runtimePrompts?: RuntimePromptBundle;
  incomingMessage: IncomingMessage;
  userContent: string;
  assistantReply: string;
  visibleReplySent: boolean;
  visibleUserMemoryContext?: string;
  tools: AgentTool[];
  runtimeInstruction: string;
  controlMessage: string;
  /** Named model execution policy for this private maintenance pass. */
  modelProfile?: string;
  maxToolCalls?: number;
  /** End after a complete tool round containing these mutations unless any tool result needs repair. */
  terminateAfterSuccessfulToolRoundNames?: readonly string[];
  transcript?: OpenRouterMessage[];
  promptContext?: MaintenancePromptContext;
  log?: Logger;
  requestLog?: RequestLog;
  completeChat?: ChatCompleteFn;
  signal?: AbortSignal;
  /** Cache the current pass input because another maintenance pass will consume it. */
}

/** Attachment data for a generated voice message. */
export interface VoiceAttachment {
  buffer: Buffer;
  filename: string;
  contentType: string;
  historyText?: string;
}

/** Binary attachment queued for an outgoing Discord message. */
export interface OutboundAttachment {
  id: string;
  buffer: Buffer;
  filename: string;
  contentType: string;
  requestedSize?: string;
  actualSize?: string;
  transport?: string;
  is4k?: boolean;
}

/** Image bytes attached to the current synthetic or live turn for native model vision. */
export interface CurrentTurnImageInput {
  buffer: Buffer;
  contentType: string;
  metadataText?: string;
}

/** Optional Discord-native presentation for a visible message. */
export interface MessagePresentation {
  kind: "components_v2_card";
  accentColor?: number;
  /** Stable component identity used to recognize structured cards received from another bot. */
  componentId?: number;
  /** Prompt representation stored instead of the visible card text. */
  history?: {
    text: string;
  };
}

/** Callback that performs the actual Discord send. */
export type MessageSender = (
  text: string,
  reply: boolean,
  channelId: string | undefined,
  voice?: VoiceAttachment,
  signal?: AbortSignal,
  replyToMessageId?: string,
  attachments?: OutboundAttachment[],
  dedupeKey?: string,
  presentation?: MessagePresentation,
) => Promise<{ sentMessageId: string; warnings?: string[] }>;

/** Resolves stored chat asset IDs into Discord-ready file attachments. */
export type AssetAttachmentResolver = (assetIds: AssetRef[]) => Promise<OutboundAttachment[]>;

/** Optional streamed response transport used by live voice instead of Discord text dispatch. */
export interface ExternalResponseSink {
  startModelTurn: () => void;
  push: (delta: string) => Promise<boolean>;
  finish: (finalText: string) => Promise<{ visible: boolean; memoryText: string; malformed: boolean }>;
  abort: (userId?: string) => void;
}

/** Dependencies injected into the handler. No direct discord.js coupling. */
export interface HandlerDeps {
  globalConfig: GlobalConfig;
  guildConfig: GuildConfig;
  context: AssembledContext;
  /** Discord channel/thread that initiated this reply loop. */
  currentChannelId?: string;
  systemPrompt?: string;
  personaPrompt?: string;
  runtimePrompts?: RuntimePromptBundle;
  sender: MessageSender;
  /** Native OpenRouter tools exposed to the model. */
  extraTools?: AgentTool[];
  log?: Logger;
  onTriggered?: (result: NonNullable<TriggerResult>) => void;
  /** Called when work continues after a user-visible message so typing can be sent before later output. */
  onStillWorking?: (channelId: string | undefined) => void | Promise<void>;
  /** Timestamp when the current typing indicator loop started, or 0 when inactive. */
  getTypingStartedAt?: () => number;
  /** Called after user-visible output starts so continuous background typing can stop. */
  onVisibleOutput?: () => void;
  /** Reports public output produced directly by a state-changing tool in this reply loop. */
  hasExternalVisibleOutput?: () => boolean;
  /** Minimum visible typing time before a buffered streamed follow-up message is sent. */
  liveMessageTypingHoldMs?: number;
  onAgentEnd?: () => void;
  requestLog?: RequestLog;
  ttsEnabled?: boolean;
  generateSpeech?: (text: string) => Promise<TtsResult>;
  forceTrigger?: boolean;
  triggerOverride?: NonNullable<TriggerResult>;
  completeChat?: ChatCompleteFn;
  afterReply?: (request: MemoryExtractionRequest) => Promise<void>;
  /** Registers fire-and-forget maintenance so coordinated shutdown can await it. */
  trackBackgroundTask?: (task: Promise<void>) => void;
  /** Persists prompt-only assistant traces such as ignored replies. */
  onIgnoredReply?: (request: IgnoredReplyRequest) => void | Promise<void>;
  /** Live metadata result for the selected model profile. Unknown means try native image input first. */
  modelImageInputSupport?: ModelImageInputSupport;
  /** Consume generated image attachments by opaque IDs returned from image tools. */
  consumeGeneratedAttachments?: (ids: string[]) => OutboundAttachment[];
  /** Resolves asset_ids on <message> envelopes into outgoing Discord attachments. */
  resolveAssetAttachments?: AssetAttachmentResolver;
  /** Disable streamed Discord sends so callers can re-check state before final delivery. */
  disableLiveOutput?: boolean;
  /** Replace normal text/voice directive dispatch with a live external stream. */
  externalResponseSink?: ExternalResponseSink;
  /** Named model execution policy override for specialized visible turns such as live voice. */
  modelProfile?: string;
  /** Optional caller cancellation, used for voice barge-in and session departure. */
  abortSignal?: AbortSignal;
  /** Called immediately before final visible sends; false drops the reply as stale. */
  preSendCheck?: (draftText: string) => boolean | Promise<boolean>;
  scheduledTaskRun?: boolean;
}

export interface HandleResult {
  triggered: boolean;
  triggerResult: TriggerResult;
  agentRan: boolean;
  responseText?: string;
  /** Authored private monologue from complete `<thoughts>` blocks. */
  privateThoughts?: string[];
  maintenanceTranscript?: OpenRouterMessage[];
  availableTools?: AgentTool[];
  promptContext?: MaintenancePromptContext;
}

type DispatchSegment =
  | { kind: "text"; text: string; delivery?: MessageDelivery }
  | {
    kind: "voice";
    text: string;
    voiceText: string;
    historyText: string;
    fallbackText: string;
    delivery?: MessageDelivery;
  };

const DEFAULT_LIVE_MESSAGE_TYPING_HOLD_MS = 2000;
const MAX_INTERNAL_SKILL_LOADS_PER_LOOP = 8;

class ModelOutputTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM output timed out after ${timeoutMs}ms`);
    this.name = "ModelOutputTimeoutError";
  }
}

class AgentTimeBudgetExceededError extends Error {
  constructor(timeoutMs: number) {
    super(`Native reply loop agent time budget exhausted after ${timeoutMs}ms`);
    this.name = "AgentTimeBudgetExceededError";
  }
}

class EmptyModelResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyModelResponseError";
  }
}

const MODEL_TURN_MAX_ATTEMPTS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isDiscordSendPermissionError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === 50001 || error.code === 50013;
}

function summarizeToolResult(result: AgentToolResult<unknown>): string {
  const textContent = result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (textContent !== "") return textContent;
  if (result.details === undefined) return "(no tool output)";
  try {
    return JSON.stringify(result.details);
  } catch {
    return "(unserializable tool details)";
  }
}

function imagePartsFromToolResult(result: AgentToolResult<unknown>): OpenRouterImageUrlPart[] {
  const images: OpenRouterImageUrlPart[] = [];
  for (const part of result.content) {
    if (!isRecord(part)) continue;
    if (part.type !== "image") continue;
    if (typeof part.data !== "string" || typeof part.mimeType !== "string") continue;
    images.push({
      type: "image_url",
      image_url: { url: `data:${part.mimeType};base64,${part.data}` },
    });
  }
  return images;
}

interface ImageFallbackRuntime {
  enabled: boolean;
  model: string;
  provider: LlmProvider;
  apiKey: string;
  providerParams: Record<string, unknown>;
  complete: ChatCompleteFn;
  llmOutputTimeoutMs: number;
  imageDescriptionSystemPrompt?: string;
  requestLog?: RequestLog;
  signal?: AbortSignal;
  log?: Logger;
}

interface ImageFollowUpSource {
  toolCallId: string;
  toolName: string;
  metadataText: string;
}

const FALLBACK_IMAGE_DESCRIPTION_SYSTEM_PROMPT = "Describe image pixels for a chat model that cannot read image input.";

function imageFollowUpMessage(
  call: OpenRouterToolCall,
  images: OpenRouterImageUrlPart[],
  metadataText: string,
): { message: OpenRouterMessage; source: ImageFollowUpSource } {
  const text: OpenRouterTextPart = {
    type: "text",
    text: [
      `Images returned by ${call.function.name}; use the previous tool result for image metadata.`,
      metadataText.trim() !== "" ? `Image metadata:\n${metadataText.trim()}` : "",
    ].filter((part) => part !== "").join("\n\n"),
  };
  return {
    message: {
      role: "user",
      content: [text, ...images],
    },
    source: {
      toolCallId: call.id,
      toolName: call.function.name,
      metadataText,
    },
  };
}

function setToolResultContent(
  messages: OpenRouterMessage[],
  toolCallId: string,
  content: string,
): boolean {
  const message = messages.find((candidate) =>
    candidate.role === "tool" && candidate.tool_call_id === toolCallId
  );
  if (message === undefined) return false;
  message.content = content;
  return true;
}

function imageUnsupportedText(): string {
  return "Image reading failed because the current LLM endpoint cannot read image input; continue using only available text metadata.";
}

function imageFallbackSourceName(source: ImageFollowUpSource | undefined): string {
  return source?.toolName ?? "a prior image tool result";
}

function imageFallbackMetadata(
  source: ImageFollowUpSource | undefined,
  message: OpenRouterMessage,
): string {
  return source?.metadataText ?? textFromMessageParts(message);
}

function removeImageFollowUp(
  messages: OpenRouterMessage[],
  index: number,
): void {
  messages.splice(index, 1);
}

function messageHasImageUrl(message: OpenRouterMessage): boolean {
  return Array.isArray(message.content)
    && message.content.some((part) => part.type === "image_url");
}

function imagePartsFromMessage(message: OpenRouterMessage): OpenRouterImageUrlPart[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter((part): part is OpenRouterImageUrlPart => part.type === "image_url");
}

function textFromMessageParts(message: OpenRouterMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is OpenRouterTextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function portableActorTurnEvidence(
  transcript: readonly OpenRouterMessage[] | undefined,
  assistantReply: string,
): string {
  const evidence = (transcript ?? []).flatMap((message): string[] => {
    if (message.role !== "assistant" && message.role !== "tool") return [];
    const text = textFromMessageParts(message);
    const calls = (message.tool_calls ?? []).map((call) =>
      `${call.function.name}(${call.function.arguments})`
    );
    const parts = [
      ...(text !== "" ? [text] : []),
      ...(calls.length > 0 ? [`Tool calls:\n${calls.join("\n")}`] : []),
    ];
    if (parts.length === 0) return [];
    const source = message.role === "tool" ? `tool:${message.name ?? "unknown"}` : "assistant";
    return [`[${source}]\n${parts.join("\n")}`];
  });
  if (evidence.length > 0) return evidence.join("\n\n");
  return assistantReply.trim();
}

async function describeImagesWithFallback(input: {
  fallback: ImageFallbackRuntime;
  images: OpenRouterImageUrlPart[];
  metadataText: string;
  sourceName: string;
  reason: string;
}): Promise<string> {
  const imageCount = input.images.length;
  if (!input.fallback.enabled || imageCount === 0) {
    return appendImageUnsupportedToolText(input.metadataText, imageCount);
  }

  const prompt = [
    `Native image reading is unavailable in the main model (${input.reason}).`,
    `The images came from ${input.sourceName}.`,
    input.metadataText.trim() !== "" ? `Metadata already known:\n${input.metadataText.trim()}` : "",
    "Describe the image pixels in maximum useful detail for the main chat model.",
  ].filter((part) => part !== "").join("\n\n");

  try {
    const result = await completeModelTurnWithRetries({
      complete: input.fallback.complete,
      request: {
        provider: input.fallback.provider,
        apiKey: input.fallback.apiKey,
        model: input.fallback.model,
        systemPrompt: input.fallback.imageDescriptionSystemPrompt?.trim() !== ""
          ? input.fallback.imageDescriptionSystemPrompt ?? FALLBACK_IMAGE_DESCRIPTION_SYSTEM_PROMPT
          : FALLBACK_IMAGE_DESCRIPTION_SYSTEM_PROMPT,
        providerParams: input.fallback.providerParams,
        messages: [{
          role: "user",
          content: [{ type: "text", text: prompt }, ...input.images],
        }],
        toolChoice: "none",
        parallelToolCalls: false,
        signal: input.fallback.signal,
        onPayload: (payload: unknown) => {
          input.fallback.requestLog?.recordLLMRequest(payload);
          input.fallback.log?.debug("image_fallback_llm_request_payload", { payload });
        },
      },
      timeoutMs: input.fallback.llmOutputTimeoutMs,
      requestLog: input.fallback.requestLog,
      log: input.fallback.log,
    });
    input.fallback.requestLog?.recordLLMCompletion(result.messageForLogs);

    const description = result.text.trim();
    const notice = `Native image reading was unavailable for the main model, so the image${imageCount === 1 ? " was" : "s were"} described by fallback image model ${input.fallback.model}.`;
    return [
      input.metadataText.trim(),
      notice,
      description !== "" ? `Fallback image description:\n${description}` : "Fallback image description failed: model returned an empty description.",
    ].filter((part) => part !== "").join("\n\n");
  } catch (error) {
    const notice = `Native image reading was unavailable for the main model, and fallback image model ${input.fallback.model} failed.`;
    return [
      input.metadataText.trim(),
      notice,
      `Fallback image description error: ${makeToolErrorText(error)}`,
    ].filter((part) => part !== "").join("\n\n");
  }
}

async function replaceUnsupportedImageMessages(
  messages: OpenRouterMessage[],
  fallback: ImageFallbackRuntime | undefined,
  reason: string,
  imageFollowUpSources: ReadonlyMap<OpenRouterMessage, ImageFollowUpSource>,
): Promise<boolean> {
  let replaced = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined) continue;
    if (!messageHasImageUrl(message)) continue;
    const source = imageFollowUpSources.get(message);
    const images = imagePartsFromMessage(message);
    const replacement = fallback !== undefined && fallback.enabled
      ? await describeImagesWithFallback({
        fallback,
        images,
        metadataText: imageFallbackMetadata(source, message),
        sourceName: imageFallbackSourceName(source),
        reason,
      })
      : imageUnsupportedText();

    if (source !== undefined && setToolResultContent(messages, source.toolCallId, replacement)) {
      removeImageFollowUp(messages, i);
    } else {
      const originalText = textFromMessageParts(message);
      message.content = [originalText, replacement].filter((part) => part !== "").join("\n\n");
    }
    replaced = true;
  }
  return replaced;
}

function isImageInputUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("No endpoints found that support image input")
    || message.includes("does not support image input")
    || message.includes("cannot read image input")
    || message.includes("Invalid value: 'input_image'. Supported values are: 'input_text'.")
    || message.includes('Invalid value: "input_image". Supported values are: "input_text".');
}

function appendImageUnsupportedToolText(text: string, imageCount: number): string {
  const notice = `Image reading failed because the current LLM endpoint cannot read image input, so ${imageCount === 1 ? "the image was" : "the images were"} not sent; use available text metadata or say images cannot be inspected with this model.`;
  return text.trim() === "" ? notice : `${text.trim()}\n\n${notice}`;
}

function supportsNativeImageInput(
  modelInput: readonly string[],
  metadataSupport: ModelImageInputSupport | undefined,
): boolean {
  if (metadataSupport === "supported" || metadataSupport === "unknown") return true;
  if (metadataSupport === "unsupported") return false;
  return modelInput.includes("image");
}

function toolToOpenRouterTool(tool: AgentTool): OpenRouterToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
    },
  };
}

function toolContractSignature(tools: readonly AgentTool[]): string {
  return createHash("sha256")
    .update(JSON.stringify(tools.map(toolToOpenRouterTool)))
    .digest("hex");
}

function parseToolArguments(call: OpenRouterToolCall): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = call.function.arguments.trim() === "" ? {} : JSON.parse(call.function.arguments);
  } catch {
    throw new Error(`Tool ${call.function.name} arguments are not valid JSON.`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`Tool ${call.function.name} arguments must be an object.`);
  }
  return parsed;
}

async function executeNativeToolCall(
  tool: AgentTool,
  call: OpenRouterToolCall,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<unknown>> {
  if (signal?.aborted === true) {
    throw abortReason(signal, `Tool ${tool.name} aborted before execution.`);
  }
  const args = parseToolArguments(call);
  const validationCall: ToolCall = {
    type: "toolCall",
    id: call.id,
    name: tool.name,
    arguments: args,
  };
  validateToolArguments(tool, validationCall);
  return await abortable(tool.execute(call.id, args, signal), signal);
}

function makeToolErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelProviderName(request: OpenRouterChatRequest): string {
  return request.provider === "openai-codex" ? "OpenAI Codex" : "OpenRouter";
}

function isProviderTransientErrorMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized === "not found"
    || normalized.includes("not found")
    || normalized.includes("bad gateway")
    || normalized.includes("cloudflare")
    || normalized.includes("service unavailable")
    || normalized.includes("server_error")
    || normalized.includes("gateway timeout")
    || normalized.includes("rate limit")
    || normalized.includes("overloaded")
    || normalized.includes("temporarily unavailable")
    || normalized.includes("you can retry your request")
    || /\b(408|409|425|429|500|502|503|504)\b/.test(normalized);
}

function normalizeModelTurnError(error: unknown, request: OpenRouterChatRequest): Error {
  const message = makeToolErrorText(error);
  if (error instanceof ModelProviderError) return error;
  if (error instanceof EmptyModelResponseError || error instanceof ModelOutputTimeoutError) return error;
  if (isAgentTimeBudgetExceededError(error)) return error instanceof Error ? error : new Error(message);
  const provider = modelProviderName(request);
  if (message.startsWith(`${provider} request failed:`) || message.startsWith("LLM provider request failed:")) {
    return error instanceof Error ? error : new Error(message);
  }
  if (isProviderTransientErrorMessage(message)) {
    return new Error(`${provider} request failed: ${message}`);
  }
  return error instanceof Error ? error : new Error(message);
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

function isAgentTimeBudgetExceededError(error: unknown): boolean {
  return error instanceof Error && error.name === "AgentTimeBudgetExceededError";
}

function isAgentTimeBudgetExceededSignal(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && isAgentTimeBudgetExceededError(signal.reason);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await promise;
  if (signal.aborted) {
    throw abortReason(signal, "Operation aborted");
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal, "Operation aborted"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function intermediateStatusText(text: string): { text: string; malformedPrivateOutput: boolean } {
  const parsed = parseResponseDirectives(text);
  if (parsed.ignored || parsed.malformedPrivateOutput === true) {
    return { text: "", malformedPrivateOutput: parsed.malformedPrivateOutput === true };
  }
  return {
    text: parsed.segments
    .filter((segment): segment is Extract<ResponseSegment, { kind: "text" }> => segment.kind === "text")
    .map((segment) => segment.text)
    .join("\n")
    .trim(),
    malformedPrivateOutput: false,
  };
}

function modelTurnStopReason(result: OpenRouterChatResult): string | undefined {
  return result.stopReason;
}

function buildRuntimeInstruction(runtimePrompts: RuntimePromptBundle | undefined): string {
  const external = runtimePrompts?.reply.trim() ?? "";
  if (external !== "") return external;
  return "## Runtime\nYou are present in this Discord room. Given the room state and new event, produce your next action and use tools only when useful.";
}

function buildSkillsInstruction(runtimePrompts: RuntimePromptBundle | undefined): string {
  return runtimePrompts?.skills.indexPrompt.trim() ?? "";
}

function buildFinalActionInstruction(runtimePrompts: RuntimePromptBundle | undefined, scheduledTaskRun = false): string {
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

function promptTransportForProvider(
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

function sectionsForStablePrompt(
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
  return stable;
}

/** Build a channel-isolated provider session id for transport continuation. */
function buildProviderSessionId(requestLog: RequestLog | undefined, modelId: string): string | undefined {
  if (requestLog === undefined) return undefined;
  const sessionId = `2b2v:${requestLog.guildId}:${requestLog.channelId}:${modelId}`;
  if (sessionId.length <= 64) return sessionId;
  return `2b2v:${createHash("sha256").update(sessionId).digest("hex").slice(0, 58)}`;
}

/** Build a stable cache-routing key for one prompt family. */
function buildCodexPromptCacheKey(
  runtimeProfileId: string,
  modelProfileId: string,
  modelId: string,
  surface: "discord-actor",
): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ runtimeProfileId, modelProfileId, modelId, surface }))
    .digest("hex");
  return `2b2v:prompt:${fingerprint.slice(0, 48)}`;
}

interface VolatilePromptMessage {
  sectionId: PromptTransportSectionId;
  text: string;
}

const VOLATILE_SECTION_IDS_BY_LABEL: Readonly<Record<string, PromptTransportSectionId>> = {
  "Discord Context": "discordContext",
  "Upcoming Schedules": "upcomingSchedules",
  "Memories": "memories",
  "Inner Threads": "innerThreads",
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
  "recentHistory",
  "memories",
  "innerThreads",
  "upcomingSchedules",
  "serverMembers",
  "threadsInChannel",
  "currentContext",
  "personaMode",
  "responseInstruction",
];

function buildVolatileTurnMessages(context: AssembledContext): VolatilePromptMessage[] {
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

function initialMessageRoles(
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
function codexSystemPromptForStableSections(
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
  if (msg.assets !== undefined) lines.push(...formatAssetMeta("", msg.assets));
  if (msg.repliedToBotRouteSource !== undefined) {
    lines.push("Reply Context: The current event replies to a message you previously sent here from another channel.");
    lines.push(`Source GuildID: ${msg.repliedToBotRouteSource.sourceGuildId}`);
    lines.push(`Source ChannelID: ${msg.repliedToBotRouteSource.sourceChannelId}`);
    lines.push(`Source MsgID: ${msg.repliedToBotRouteSource.sourceMessageId}`);
    lines.push(runtimeContextTemplate(
      runtimePrompts,
      "routed-reply-source",
      {
        sourceGuildId: msg.repliedToBotRouteSource.sourceGuildId,
        sourceChannelId: msg.repliedToBotRouteSource.sourceChannelId,
        sourceMessageId: msg.repliedToBotRouteSource.sourceMessageId,
      },
      "Use chat history/search if source context is needed for your next action; do not expose source-channel details unless relevant.",
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

function buildInitialMessages(
  userContent: string,
  volatileMessages: readonly VolatilePromptMessage[],
  msg: IncomingMessage,
  runtimePrompts?: RuntimePromptBundle,
  roles: readonly PromptTransportRole[] = ["user"],
  finalActionInstruction = "",
): OpenRouterMessage[] {
  const roleAt = (index: number): PromptTransportRole => roles[index] ?? "user";
  const currentMessageMetadata = [
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
      msg.currentContentInHistory === true ? "" : `## ${msg.eventPrompt?.contentHeading ?? "Current Discord Message"}`,
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

function assistantMessageFromResult(result: OpenRouterChatResult): OpenRouterMessage {
  return {
    role: "assistant",
    content: result.text !== "" ? result.text : null,
    tool_calls: result.toolCalls,
    ...(result.providerNativeContent !== undefined && result.providerNativeContent.length > 0
      ? { providerNativeContent: result.providerNativeContent }
      : {}),
  };
}

function toolMessage(call: OpenRouterToolCall, content: string): OpenRouterMessage {
  return {
    role: "tool",
    tool_call_id: call.id,
    name: call.function.name,
    content,
  };
}

function runtimeContextTemplate(
  runtimePrompts: RuntimePromptBundle | undefined,
  name: string,
  variables: Record<string, string | number | boolean | undefined>,
  fallback: string,
): string {
  const template = runtimePrompts?.contextTemplates[name];
  return template === undefined ? fallback : renderPromptTemplate(template, variables);
}

function toolBudgetExhaustedMessage(kind: "calls" | "rounds", runtimePrompts?: RuntimePromptBundle): string {
  const label = kind === "calls" ? "tool call" : "tool round";
  return runtimeContextTemplate(
    runtimePrompts,
    "tool-budget-exhausted",
    { label },
    `Native ${label} budget exhausted before this tool could run; stop tool use.`,
  );
}

function agentTimeBudgetExhaustedMessage(timeoutMs: number, runtimePrompts?: RuntimePromptBundle): string {
  return runtimeContextTemplate(
    runtimePrompts,
    "agent-time-budget-exhausted",
    { timeoutMs },
    `Native agent time budget exhausted after ${timeoutMs}ms; stop tool use.`,
  );
}

async function completeWithTimeout(
  complete: ChatCompleteFn,
  request: OpenRouterChatRequest,
  timeoutMs: number,
): Promise<OpenRouterChatResult> {
  const controller = new AbortController();
  const parent = request.signal;
  let onParentAbort: (() => void) | undefined;
  if (parent !== undefined) {
    if (parent.aborted) {
      throw parent.reason instanceof Error ? parent.reason : new Error("LLM request aborted");
    }
    onParentAbort = () => controller.abort(parent.reason);
    parent.addEventListener("abort", onParentAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    controller.abort(new ModelOutputTimeoutError(timeoutMs));
  }, timeoutMs);

  try {
    return await complete({ ...request, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason instanceof Error) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (parent !== undefined && onParentAbort !== undefined) {
      parent.removeEventListener("abort", onParentAbort);
    }
  }
}

async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted");
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
    };
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isRetriableModelTurnError(error: unknown): boolean {
  if (error instanceof ModelProviderError) return error.retryable;
  if (error instanceof OutboundXmlTagError) return true;
  if (error instanceof EmptyModelResponseError) return true;
  if (error instanceof Error && error.name === "ModelOutputTimeoutError") return true;
  return isProviderTransientErrorMessage(makeToolErrorText(error));
}

function emptyModelResponse(message: string): EmptyModelResponseError {
  return new EmptyModelResponseError(message);
}

function requireTextResult(message: string): (result: OpenRouterChatResult) => Error | undefined {
  return (result) => result.text.trim() === "" ? emptyModelResponse(message) : undefined;
}

function requireTextUnlessToolCalls(message: string): (result: OpenRouterChatResult) => Error | undefined {
  return (result) => result.toolCalls.length === 0 && result.text.trim() === ""
    ? emptyModelResponse(message)
    : undefined;
}

async function completeModelTurnWithRetries(input: {
  complete: ChatCompleteFn;
  request: OpenRouterChatRequest;
  timeoutMs: number;
  maxAttempts?: number;
  validateResult?: (result: OpenRouterChatResult) => Error | undefined;
  onAttemptStart?: () => void;
  hasCompletedVisibleMessage?: () => boolean;
  requestLog?: RequestLog;
  log?: Logger;
}): Promise<OpenRouterChatResult> {
  const maxAttempts = input.maxAttempts ?? MODEL_TURN_MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      input.onAttemptStart?.();
      const result = await completeWithTimeout(input.complete, input.request, input.timeoutMs);
      const validationError = input.validateResult?.(result);
      if (validationError !== undefined) {
        const normalizedError = normalizeModelTurnError(validationError, input.request);
        const shouldRetry = attempt < maxAttempts
          && input.hasCompletedVisibleMessage?.() !== true
          && isRetriableModelTurnError(normalizedError);
        input.requestLog?.recordLLMError(normalizedError, result.messageForLogs);
        if (!shouldRetry) throw normalizedError;
        input.log?.warn("retrying LLM turn", {
          attempt,
          maxAttempts,
          error: makeToolErrorText(normalizedError),
        });
        await sleepMs(retryBackoffMs(attempt), input.request.signal);
        continue;
      }
      return result;
    } catch (error) {
      const normalizedError = normalizeModelTurnError(error, input.request);
      const outboundXmlRejected = normalizedError instanceof OutboundXmlTagError;
      const shouldRetry = attempt < maxAttempts
        && (outboundXmlRejected || input.hasCompletedVisibleMessage?.() !== true)
        && isRetriableModelTurnError(normalizedError);
      if (shouldRetry && outboundXmlRejected) {
        input.request.messages.push({
          role: "system",
          content: normalizedError.message,
        });
      }
      if (!isAgentTimeBudgetExceededError(normalizedError)) {
        input.requestLog?.recordLLMError(normalizedError);
      }
      if (!shouldRetry) {
        throw normalizedError;
      }
      input.log?.warn("retrying LLM turn", {
        attempt,
        maxAttempts,
        error: makeToolErrorText(normalizedError),
      });
      await sleepMs(retryBackoffMs(attempt), input.request.signal);
    }
  }

  throw new Error("LLM retry loop ended without a result.");
}

function retryBackoffMs(attempt: number): number {
  const baseMs = 250 * (2 ** Math.max(0, attempt - 1));
  return Math.round(baseMs * (0.8 + Math.random() * 0.4));
}

const PARALLEL_SAFE_READ_ONLY_TOOLS = new Set([
  "list_channel_messages",
  "fetch_images",
  "fetch_url",
  "search_memories",
  "list_emojis",
  "list_scheduled_tasks",
  "list_chat_users",
  "list_channels",
  "list_agent_jobs",
  "read_asset",
  "read_agent_job",
  "read_user_avatar",
  "search_channel_messages",
  "search_images",
  "summarize_video",
  "web_search",
]);

/**
 * Only repo-owned tools with read-only semantics are allowed to run together.
 * Unknown/custom tools default to ordered execution because their side effects are not known here.
 */
function canRunToolInParallel(tool: AgentTool): boolean {
  return PARALLEL_SAFE_READ_ONLY_TOOLS.has(tool.name);
}

interface ExecutedToolCall {
  call: OpenRouterToolCall;
  tool: AgentTool;
  result?: AgentToolResult<unknown>;
  errorText?: string;
}

function generatedAttachmentIdsFromToolResult(result: AgentToolResult<unknown>): string[] {
  const details = isRecord(result.details) ? result.details : undefined;
  const ids = details?.generatedAttachmentIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string" && id !== "");
}

function asyncImageJobCreatedFromToolResult(result: AgentToolResult<unknown>): boolean {
  const details = isRecord(result.details) ? result.details : undefined;
  return details?.asyncJobCreated === true;
}

function toolResultNeedsRepair(result: AgentToolResult<unknown>): boolean {
  const details = isRecord(result.details) ? result.details : undefined;
  if (details === undefined) return false;
  if (details.error !== undefined && details.error !== false && details.error !== null && details.error !== "") {
    return true;
  }
  if (Array.isArray(details.errors) && details.errors.length > 0) return true;
  return Array.isArray(details.rejected) && details.rejected.length > 0;
}

function toolExecutionNeedsRepair(execution: ExecutedToolCall): boolean {
  return execution.result === undefined || toolResultNeedsRepair(execution.result);
}

function didCloseCurrentChannel(input: {
  tool: AgentTool;
  result: AgentToolResult<unknown>;
  currentChannelId?: string;
}): boolean {
  if (input.currentChannelId === undefined || input.tool.name !== "close_thread") return false;
  const details = isRecord(input.result.details) ? input.result.details : undefined;
  return details?.channel_id === input.currentChannelId;
}

async function executeToolCallForLoop(input: {
  tool: AgentTool;
  call: OpenRouterToolCall;
  signal?: AbortSignal;
  requestLog?: RequestLog;
}): Promise<ExecutedToolCall> {
  input.requestLog?.recordToolStart(input.call.id, input.tool.name, parseToolArgumentsSafe(input.call));
  try {
    const result = await executeNativeToolCall(input.tool, input.call, input.signal);
    input.requestLog?.recordToolEnd(input.call.id, toolResultNeedsRepair(result), result);
    return { call: input.call, tool: input.tool, result };
  } catch (error) {
    const errorText = makeToolErrorText(error);
    input.requestLog?.recordToolEnd(input.call.id, true, {
      content: [{ type: "text", text: errorText }],
    });
    return { call: input.call, tool: input.tool, errorText };
  }
}

async function renderExecutedToolCall(input: {
  execution: ExecutedToolCall;
  imageInputSupported: boolean;
  imageFallback?: ImageFallbackRuntime;
  imageFollowUpSources: Map<OpenRouterMessage, ImageFollowUpSource>;
  imageMessages: OpenRouterMessage[];
  consumeGeneratedAttachments?: (ids: string[]) => OutboundAttachment[];
  pendingAttachments: OutboundAttachment[];
}): Promise<{ resultText: string; asyncImageJobCreated: boolean }> {
  if (input.execution.result === undefined) {
    return {
      resultText: input.execution.errorText ?? "Tool failed without an error message.",
      asyncImageJobCreated: false,
    };
  }

  const { call, tool, result } = input.execution;
  const asyncImageJobCreated = tool.name === "codex_generate_image" && asyncImageJobCreatedFromToolResult(result);
  const generatedAttachmentIds = generatedAttachmentIdsFromToolResult(result);
  if (generatedAttachmentIds.length > 0) {
    input.pendingAttachments.push(...(input.consumeGeneratedAttachments?.(generatedAttachmentIds) ?? []));
  }
  const images = imagePartsFromToolResult(result);
  let resultText = summarizeToolResult(result);

  if (images.length > 0 && input.imageInputSupported) {
    const followUp = imageFollowUpMessage(call, images, resultText);
    input.imageFollowUpSources.set(followUp.message, followUp.source);
    input.imageMessages.push(followUp.message);
  } else if (images.length > 0 && input.imageFallback?.enabled === true) {
    resultText = await describeImagesWithFallback({
      fallback: input.imageFallback,
      images,
      metadataText: resultText,
      sourceName: tool.name,
      reason: "the selected main model does not advertise image input support",
    });
  } else if (images.length > 0) {
    resultText = appendImageUnsupportedToolText(resultText, images.length);
  }

  return { resultText, asyncImageJobCreated };
}

function loadedSkillIdFromResult(result: AgentToolResult<unknown>): string | undefined {
  const details = isRecord(result.details) ? result.details : undefined;
  return typeof details?.skillId === "string" && details.skillId !== "" ? details.skillId : undefined;
}

function blockedForMissingSkillExecution(input: {
  call: OpenRouterToolCall;
  tool: AgentTool;
  requiredSkillId: string;
  requestLog?: RequestLog;
}): ExecutedToolCall {
  const message = `${input.tool.name} requires the ${input.requiredSkillId} skill. Call load_skill with skill="${input.requiredSkillId}" before using ${input.tool.name}.`;
  input.requestLog?.recordToolSkipped(
    input.call.id,
    input.tool.name,
    parseToolArgumentsSafe(input.call),
    message,
  );
  return {
    call: input.call,
    tool: input.tool,
    result: {
      content: [{ type: "text", text: message }],
      details: { error: true, requiredSkillId: input.requiredSkillId },
    },
  };
}

async function runNativeToolLoop(input: {
  complete: ChatCompleteFn;
  requestBase: Omit<OpenRouterChatRequest, "messages">;
  messages: OpenRouterMessage[];
  tools: AgentTool[];
  maxToolCalls: number;
  maxToolRounds: number;
  agentTimeBudgetMs: number;
  llmOutputTimeoutMs: number;
  requestLog?: RequestLog;
  sendIntermediateText?: (text: string, channelId: string | undefined) => Promise<boolean>;
  streamFinalText?: (delta: string, channelId: string | undefined) => Promise<boolean>;
  onModelTurnStart?: (channelId: string | undefined) => void;
  onStillWorking?: (channelId: string | undefined) => void | Promise<void>;
  hasExternalVisibleOutput?: () => boolean;
  currentChannelId?: string;
  imageInputSupported: boolean;
  imageFallback?: ImageFallbackRuntime;
  consumeGeneratedAttachments?: (ids: string[]) => OutboundAttachment[];
  pendingAttachments: OutboundAttachment[];
  toolTiming?: TimingState;
  runtimePrompts?: RuntimePromptBundle;
  log?: Logger;
  signal?: AbortSignal;
  allowEmptyFinalResponse?: boolean | (() => boolean);
  correctInvalidMessageDirectives?: boolean;
  stopOnAgentTimeBudget?: boolean;
  terminateAfterSuccessfulToolRoundNames?: readonly string[];
}): Promise<{ text: string; stopReason?: string }> {
  const toolsByName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const loadedSkills = new Set<string>();
  const terminateAfterSuccessfulToolRoundNames = new Set(input.terminateAfterSuccessfulToolRoundNames ?? []);
  const imageFollowUpSources = new Map<OpenRouterMessage, ImageFollowUpSource>();
  let toolCalls = 0;
  let toolRounds = 0;
  let internalSkillLoads = 0;
  let sentIntermediateStatus = false;
  const streamingState = { visibleText: false };
  let agentTimeBudgetMarked = false;
  let asyncImageJobCreated = false;
  let correctedInvalidMessageDirectives = false;
  const allowEmptyFinalResponse = (): boolean => typeof input.allowEmptyFinalResponse === "function"
    ? input.allowEmptyFinalResponse()
    : input.allowEmptyFinalResponse === true;

  const markAgentTimeBudgetExhausted = (): void => {
    if (agentTimeBudgetMarked) return;
    agentTimeBudgetMarked = true;
    input.messages.push({
      role: "system",
      content: agentTimeBudgetExhaustedMessage(input.agentTimeBudgetMs, input.runtimePrompts),
    });
    input.log?.warn("native reply loop agent time budget exhausted", {
      timeoutMs: input.agentTimeBudgetMs,
    });
  };

  const completeFinalWithoutTools = async (
    emptyResponseMessage = "Model produced an empty response after tool budget exhaustion.",
    maxAttempts = MODEL_TURN_MAX_ATTEMPTS,
    signal: AbortSignal | null | undefined = input.signal,
    recoverAgentTimeBudget = true,
  ): Promise<{ text: string; stopReason?: string }> => {
    let completedVisibleMessage = false;
    try {
      const result = await completeModelTurnWithRetries({
        complete: input.complete,
        request: {
          ...input.requestBase,
          messages: input.messages,
          tools: [],
          toolChoice: "none",
          parallelToolCalls: false,
          onTextDelta: input.streamFinalText !== undefined
            ? async (delta) => {
              const sent = await input.streamFinalText?.(delta, undefined);
              if (sent === true) {
                streamingState.visibleText = true;
                completedVisibleMessage = true;
              }
            }
            : undefined,
          signal: signal ?? undefined,
        },
        timeoutMs: input.llmOutputTimeoutMs,
        maxAttempts,
        validateResult: allowEmptyFinalResponse() ? undefined : requireTextResult(emptyResponseMessage),
        onAttemptStart: () => {
          completedVisibleMessage = false;
          input.onModelTurnStart?.(undefined);
        },
        hasCompletedVisibleMessage: () => completedVisibleMessage,
        requestLog: input.requestLog,
        log: input.log,
      });
      input.requestLog?.recordLLMCompletion(result.messageForLogs);
      const text = result.text.trim();
      const stopReason = modelTurnStopReason(result);
      if (stopReason === "length") {
        return { text, stopReason };
      }
      input.messages.push(assistantMessageFromResult({ ...result, text }));
      return { text, ...(stopReason !== undefined ? { stopReason } : {}) };
    } catch (error) {
      if (recoverAgentTimeBudget && isAgentTimeBudgetExceededError(error)) {
        return await finishAfterAgentTimeBudget();
      }
      throw error;
    }
  };

  const completeFinalAfterAgentTimeBudget = async (): Promise<{ text: string; stopReason?: string }> => {
    markAgentTimeBudgetExhausted();
    return await completeFinalWithoutTools(
      "Model produced an empty response after agent time budget exhaustion.",
      1,
      null,
      false,
    );
  };

  const finishAfterAgentTimeBudget = async (): Promise<{ text: string; stopReason?: string }> => {
    if (input.stopOnAgentTimeBudget === true) {
      return { text: "" };
    }
    return await completeFinalAfterAgentTimeBudget();
  };

  const agentTimeBudgetToolMessage = (): string => agentTimeBudgetExhaustedMessage(input.agentTimeBudgetMs, input.runtimePrompts);

  const appendSkippedToolCallsForAgentTimeBudget = (calls: OpenRouterToolCall[]): void => {
    for (const skippedCall of calls) {
      input.requestLog?.recordToolSkipped(
        skippedCall.id,
        skippedCall.function.name,
        parseToolArgumentsSafe(skippedCall),
        agentTimeBudgetToolMessage(),
      );
      input.messages.push(toolMessage(skippedCall, agentTimeBudgetToolMessage()));
    }
  };

  for (;;) {
    let result: OpenRouterChatResult;
    let completedVisibleMessage = false;
    try {
      input.toolTiming?.markModelTurnStart();
      result = await completeModelTurnWithRetries({
        complete: input.complete,
        request: {
          ...input.requestBase,
          messages: input.messages,
          tools: input.tools.map(toolToOpenRouterTool),
          toolChoice: input.tools.length > 0 ? "auto" : "none",
          parallelToolCalls: true,
          onTextDelta: input.streamFinalText !== undefined
            ? async (delta) => {
              const sent = await input.streamFinalText?.(delta, undefined);
              if (sent === true) {
                streamingState.visibleText = true;
                completedVisibleMessage = true;
              }
            }
            : undefined,
          signal: input.signal,
        },
        timeoutMs: input.llmOutputTimeoutMs,
        validateResult: allowEmptyFinalResponse() ? undefined : requireTextUnlessToolCalls("Model produced an empty response."),
        onAttemptStart: () => {
          completedVisibleMessage = false;
          input.onModelTurnStart?.(undefined);
        },
        hasCompletedVisibleMessage: () => completedVisibleMessage,
        requestLog: input.requestLog,
        log: input.log,
      });
      input.toolTiming?.markToolCallsReady();
    } catch (error) {
      if (
        isImageInputUnsupportedError(error)
        && await replaceUnsupportedImageMessages(
          input.messages,
          input.imageFallback,
          makeToolErrorText(error),
          imageFollowUpSources,
        )
      ) {
        continue;
      }
      if (isAgentTimeBudgetExceededError(error)) {
        return await finishAfterAgentTimeBudget();
      }
      throw error;
    }
    input.requestLog?.recordLLMCompletion(result.messageForLogs);
    const stopReason = modelTurnStopReason(result);
    if (stopReason === "length") {
      const text = result.text.trim();
      return { text, stopReason };
    }

    if (result.toolCalls.length === 0) {
      const text = result.text.trim();
      const parsedDirectives = input.correctInvalidMessageDirectives === true
        ? parseResponseDirectives(text)
        : undefined;
      if (
        parsedDirectives?.directiveErrors !== undefined
        && !correctedInvalidMessageDirectives
        && !streamingState.visibleText
      ) {
        correctedInvalidMessageDirectives = true;
        input.messages.push(assistantMessageFromResult({ ...result, text }));
        input.messages.push({
          role: "system",
          content: `Correct the invalid <message> directive and return the complete response again. ${parsedDirectives.directiveErrors.join(" ")}`,
        });
        input.log?.warn("retrying reply after invalid message directive", {
          errors: parsedDirectives.directiveErrors,
        });
        continue;
      }
      input.messages.push(assistantMessageFromResult({ ...result, text }));
      return { text, ...(stopReason !== undefined ? { stopReason } : {}) };
    }

    if (!sentIntermediateStatus && !streamingState.visibleText) {
      const status = intermediateStatusText(result.text);
      if (status.malformedPrivateOutput) {
        input.log?.warn("malformed private output blocked from intermediate delivery", {
          outputLength: result.text.length,
        });
      } else if (status.text !== "" && input.sendIntermediateText !== undefined) {
        const sent = await input.sendIntermediateText(result.text, undefined);
        if (sent) {
          sentIntermediateStatus = true;
          await input.onStillWorking?.(undefined);
        }
      }
    }

    if (isAgentTimeBudgetExceededSignal(input.signal)) {
      return await finishAfterAgentTimeBudget();
    }

    const hasOperationalToolCall = result.toolCalls.some((call) => call.function.name !== "load_skill");
    if (hasOperationalToolCall && toolRounds >= input.maxToolRounds) {
      input.messages.push(assistantMessageFromResult(result));
      for (const call of result.toolCalls) {
        input.requestLog?.recordToolSkipped(
          call.id,
          call.function.name,
          parseToolArgumentsSafe(call),
          toolBudgetExhaustedMessage("rounds", input.runtimePrompts),
        );
        input.messages.push(toolMessage(call, toolBudgetExhaustedMessage("rounds", input.runtimePrompts)));
      }
      if (terminateAfterSuccessfulToolRoundNames.size > 0) return { text: "" };
      return await completeFinalWithoutTools();
    }

    input.messages.push(assistantMessageFromResult(result));

    const imageMessages: OpenRouterMessage[] = [];
    const pendingParallelCalls: Array<{ call: OpenRouterToolCall; tool: AgentTool }> = [];
    const toolRoundState = {
      sawTerminatingToolCall: false,
      needsRepair: false,
    };
    const noteToolExecution = (execution: ExecutedToolCall): void => {
      if (terminateAfterSuccessfulToolRoundNames.has(execution.tool.name)) {
        toolRoundState.sawTerminatingToolCall = true;
      }
      if (toolExecutionNeedsRepair(execution)) {
        toolRoundState.needsRepair = true;
      }
    };
    const flushParallelCalls = async (): Promise<void> => {
      if (pendingParallelCalls.length === 0) return;
      input.requestLog?.beginToolBatch(pendingParallelCalls.map(({ call }) => call.id), "parallel");
      const executions = await Promise.all(pendingParallelCalls.map(({ call, tool }) =>
        executeToolCallForLoop({
          tool,
          call,
          signal: input.signal,
          requestLog: input.requestLog,
        })
      ));
      pendingParallelCalls.length = 0;

      for (const execution of executions) {
        noteToolExecution(execution);
        if (execution.tool.name === "load_skill" && execution.result !== undefined) {
          const skillId = loadedSkillIdFromResult(execution.result);
          if (skillId !== undefined) loadedSkills.add(skillId);
        }
        const rendered = await renderExecutedToolCall({
          execution,
          imageInputSupported: input.imageInputSupported,
          imageFallback: input.imageFallback,
          imageFollowUpSources,
          imageMessages,
          consumeGeneratedAttachments: input.consumeGeneratedAttachments,
          pendingAttachments: input.pendingAttachments,
        });
        if (rendered.asyncImageJobCreated) asyncImageJobCreated = true;
        input.messages.push(toolMessage(execution.call, rendered.resultText));
      }
    };

    for (let callIndex = 0; callIndex < result.toolCalls.length; callIndex += 1) {
      const call = result.toolCalls[callIndex];
      if (call === undefined) continue;
      if (isAgentTimeBudgetExceededSignal(input.signal)) {
        await flushParallelCalls();
        appendSkippedToolCallsForAgentTimeBudget(result.toolCalls.slice(callIndex));
        input.messages.push(...imageMessages);
        return await finishAfterAgentTimeBudget();
      }
      const tool = toolsByName.get(call.function.name);
      if (tool === undefined) {
        await flushParallelCalls();
        input.requestLog?.recordToolSkipped(
          call.id,
          call.function.name,
          parseToolArgumentsSafe(call),
          `Unknown tool: ${call.function.name}`,
        );
        input.messages.push(toolMessage(call, `Unknown tool: ${call.function.name}`));
        continue;
      }

      if (tool.name === "load_skill") {
        if (internalSkillLoads >= MAX_INTERNAL_SKILL_LOADS_PER_LOOP) {
          await flushParallelCalls();
          const message = "load_skill internal budget exhausted for this turn.";
          input.requestLog?.recordToolSkipped(
            call.id,
            call.function.name,
            parseToolArgumentsSafe(call),
            message,
          );
          input.messages.push(toolMessage(call, message));
          input.messages.push(...imageMessages);
          return await completeFinalWithoutTools();
        }
        internalSkillLoads += 1;
      } else if (toolCalls >= input.maxToolCalls) {
        await flushParallelCalls();
        if (isAgentTimeBudgetExceededSignal(input.signal)) {
          appendSkippedToolCallsForAgentTimeBudget(result.toolCalls.slice(callIndex));
          input.messages.push(...imageMessages);
          return await finishAfterAgentTimeBudget();
        }
        for (const skippedCall of result.toolCalls.slice(callIndex)) {
          input.requestLog?.recordToolSkipped(
            skippedCall.id,
            skippedCall.function.name,
            parseToolArgumentsSafe(skippedCall),
            toolBudgetExhaustedMessage("calls", input.runtimePrompts),
          );
          input.messages.push(toolMessage(skippedCall, toolBudgetExhaustedMessage("calls", input.runtimePrompts)));
        }
        input.messages.push(...imageMessages);
        if (terminateAfterSuccessfulToolRoundNames.size > 0) return { text: "" };
        return await completeFinalWithoutTools();
      } else {
        toolCalls += 1;
      }

      const requiredSkillId = input.runtimePrompts?.skills.requiredByTool[tool.name];
      if (requiredSkillId !== undefined && !loadedSkills.has(requiredSkillId)) {
        await flushParallelCalls();
        const execution = blockedForMissingSkillExecution({
          call,
          tool,
          requiredSkillId,
          requestLog: input.requestLog,
        });
        const rendered = await renderExecutedToolCall({
          execution,
          imageInputSupported: input.imageInputSupported,
          imageFallback: input.imageFallback,
          imageFollowUpSources,
          imageMessages,
          consumeGeneratedAttachments: input.consumeGeneratedAttachments,
          pendingAttachments: input.pendingAttachments,
        });
        input.messages.push(toolMessage(call, rendered.resultText));
        continue;
      }

      if (canRunToolInParallel(tool)) {
        pendingParallelCalls.push({ call, tool });
        continue;
      }

      await flushParallelCalls();
      if (isAgentTimeBudgetExceededSignal(input.signal)) {
        appendSkippedToolCallsForAgentTimeBudget(result.toolCalls.slice(callIndex));
        input.messages.push(...imageMessages);
        return await finishAfterAgentTimeBudget();
      }
      input.requestLog?.beginToolBatch([call.id], "sequential");
      const execution = await executeToolCallForLoop({
        tool,
        call,
        signal: input.signal,
        requestLog: input.requestLog,
      });
      noteToolExecution(execution);
      if (execution.tool.name === "load_skill" && execution.result !== undefined) {
        const skillId = loadedSkillIdFromResult(execution.result);
        if (skillId !== undefined) loadedSkills.add(skillId);
      }
      const rendered = await renderExecutedToolCall({
        execution,
        imageInputSupported: input.imageInputSupported,
        imageFallback: input.imageFallback,
        imageFollowUpSources,
        imageMessages,
        consumeGeneratedAttachments: input.consumeGeneratedAttachments,
        pendingAttachments: input.pendingAttachments,
      });
      if (rendered.asyncImageJobCreated) asyncImageJobCreated = true;
      input.messages.push(toolMessage(call, rendered.resultText));
      if (execution.result !== undefined && didCloseCurrentChannel({
        tool,
        result: execution.result,
        currentChannelId: input.currentChannelId,
      })) {
        return { text: "" };
      }
      if (isAgentTimeBudgetExceededSignal(input.signal)) {
        appendSkippedToolCallsForAgentTimeBudget(result.toolCalls.slice(callIndex + 1));
        input.messages.push(...imageMessages);
        return await finishAfterAgentTimeBudget();
      }
    }
    await flushParallelCalls();
    input.messages.push(...imageMessages);
    if (hasOperationalToolCall) toolRounds += 1;
    if (toolRoundState.sawTerminatingToolCall && !toolRoundState.needsRepair) {
      return { text: "" };
    }
    if (asyncImageJobCreated) {
      return { text: "" };
    }
    if (isAgentTimeBudgetExceededSignal(input.signal)) {
      return await finishAfterAgentTimeBudget();
    }
    // Direct public tool output stops typing when delivered. If the agent loop
    // continues, resume immediately rather than waiting for a text segment.
    if (input.hasExternalVisibleOutput?.() === true) {
      await input.onStillWorking?.(undefined);
    }
  }

  throw new Error("Native tool loop ended without a final response.");
}

function parseToolArgumentsSafe(call: OpenRouterToolCall): Record<string, unknown> {
  try {
    return parseToolArguments(call);
  } catch {
    return {};
  }
}

function assertSentMessageId(result: { sentMessageId: string }): void {
  if (result.sentMessageId === "") {
    throw new Error("Failed to send final Discord message: no sent message ID returned.");
  }
}

function memoryExtractionContext(context: AssembledContext): string {
  return context.sections
    .filter((section) => section.label === "Chat History — Newer")
    .map((section) => section.text)
    .join("\n\n");
}

function joinNonEmpty(parts: string[]): string {
  return parts.filter((part) => part !== "").join("\n");
}

function renderSegmentsAsPlainText(segments: ResponseSegment[]): string {
  return joinNonEmpty(segments
    .filter((segment): segment is Extract<ResponseSegment, { kind: "text" | "voice" }> =>
      segment.kind === "text" || segment.kind === "voice"
    )
    .map((segment) => segment.text));
}

/**
 * Convert parsed directives into Discord sends. Text around a voice directive becomes
 * message content on the voice attachment, while only the voice body goes to TTS.
 */
function buildDispatchSegmentsForMessage(segments: Extract<ResponseSegment, { kind: "text" | "voice" }>[]): DispatchSegment[] {
  const dispatchSegments: DispatchSegment[] = [];
  const pendingText: Array<Extract<ResponseSegment, { kind: "text" }>> = [];

  for (const segment of segments) {
    if (segment.kind === "text") {
      pendingText.push(segment);
      continue;
    }

    const historySegments = [...pendingText, segment];
    dispatchSegments.push({
      kind: "voice",
      text: renderSegmentsAsPlainText(pendingText),
      voiceText: segment.text,
      historyText: renderSegmentsForMemory(historySegments),
      fallbackText: renderSegmentsAsPlainText(historySegments),
    });
    pendingText.length = 0;
  }

  if (pendingText.length > 0) {
    const text = renderSegmentsAsPlainText(pendingText);
    const trailingHistory = renderSegmentsForMemory(pendingText);
    const last = dispatchSegments[dispatchSegments.length - 1];
    if (last !== undefined && last.kind === "voice") {
      last.text = joinNonEmpty([last.text, text]);
      last.historyText = joinNonEmpty([last.historyText, trailingHistory]);
      last.fallbackText = joinNonEmpty([last.fallbackText, text]);
      return dispatchSegments;
    }
    dispatchSegments.push({ kind: "text", text });
  }

  return dispatchSegments;
}

function buildDispatchSegments(segments: ResponseSegment[]): DispatchSegment[] {
  const dispatchSegments: DispatchSegment[] = [];
  let currentMessage: Extract<ResponseSegment, { kind: "text" | "voice" }>[] = [];
  let currentDelivery: MessageDelivery | undefined;

  for (const segment of segments) {
    if (segment.kind === "text" || segment.kind === "voice") {
      currentMessage.push(segment);
      continue;
    }

    if (segment.kind === "emptyMessage") {
      const messageSegments = buildDispatchSegmentsForMessage(currentMessage);
      if (messageSegments[0] !== undefined && currentDelivery !== undefined) {
        messageSegments[0].delivery = currentDelivery;
      }
      dispatchSegments.push(...messageSegments);
      dispatchSegments.push({ kind: "text", text: "", delivery: segment.delivery });
      currentMessage = [];
      currentDelivery = undefined;
      continue;
    }

    const messageSegments = buildDispatchSegmentsForMessage(currentMessage);
    if (messageSegments[0] !== undefined && currentDelivery !== undefined) {
      messageSegments[0].delivery = currentDelivery;
    }
    dispatchSegments.push(...messageSegments);
    currentMessage = [];
    currentDelivery = segment.delivery;
  }

  const messageSegments = buildDispatchSegmentsForMessage(currentMessage);
  if (messageSegments[0] !== undefined && currentDelivery !== undefined) {
    messageSegments[0].delivery = currentDelivery;
  }
  dispatchSegments.push(...messageSegments);
  return dispatchSegments;
}

function effectiveReply(input: {
  delivery?: MessageDelivery;
  defaultReply: boolean;
  destinationChannelId?: string;
  currentChannelId?: string;
}): boolean {
  if (input.delivery?.replyTo !== undefined) return false;
  if (input.delivery?.reply !== undefined) return input.delivery.reply;
  if (input.destinationChannelId === undefined || input.destinationChannelId === input.currentChannelId) {
    return input.defaultReply;
  }
  return false;
}

function isCurrentChannelDestination(destinationChannelId: string | undefined, currentChannelId: string | undefined): boolean {
  return destinationChannelId === undefined || (
    currentChannelId !== undefined && destinationChannelId === currentChannelId
  );
}

/** Builds a stable key for one logical Discord send so transport retries can be idempotent. */
function discordSendDedupeKey(input: { requestLog?: RequestLog; sendId: string }): string {
  const requestScope = input.requestLog?.requestId ?? `${Date.now()}:${Math.random()}`;
  return createHash("sha256")
    .update(`${requestScope}:${input.sendId}`)
    .digest("base64url");
}

async function sendOneSegment(input: {
  sender: MessageSender;
  generateSpeech?: (text: string) => Promise<TtsResult>;
  ttsEnabled: boolean;
  segment: DispatchSegment;
  sendId: string;
  reply: boolean;
  destinationChannelId?: string;
  currentChannelId?: string;
  attachments?: OutboundAttachment[];
  requestLog?: RequestLog;
  signal?: AbortSignal;
  onSent?: () => void | Promise<void>;
}): Promise<void> {
  const destinationChannelId = input.segment.delivery?.channelId ?? input.destinationChannelId;
  const args: Record<string, unknown> = {
    text: input.segment.text,
    reply: effectiveReply({
      delivery: input.segment.delivery,
      defaultReply: input.reply,
      destinationChannelId,
      currentChannelId: input.currentChannelId,
    }),
    ...(input.segment.delivery?.replyTo !== undefined ? { reply_to_message_id: input.segment.delivery.replyTo } : {}),
    ...(destinationChannelId !== undefined ? { channel_id: destinationChannelId } : {}),
    ...(input.attachments !== undefined && input.attachments.length > 0
      ? { attachments: input.attachments.map((attachment) => attachment.filename) }
      : {}),
  };
  const toolName = input.segment.kind === "voice" ? "send_voice" : "send_text";
  if (input.segment.kind === "voice") {
    args.voice_text = input.segment.voiceText;
    args.history_text = input.segment.historyText;
  }
  input.requestLog?.recordToolStart(input.sendId, toolName, args);
  try {
    let voice: VoiceAttachment | undefined;
    if (input.segment.kind === "voice") {
      if (!input.ttsEnabled) {
        throw new Error("Voice messages are not enabled for this server.");
      }
      if (input.generateSpeech === undefined) {
        throw new Error("Voice generation unavailable.");
      }
      const ttsResult = await input.generateSpeech(input.segment.voiceText);
      if (!ttsResult.ok) {
        throw new Error(ttsResult.error);
      }
      voice = {
        buffer: ttsResult.buffer,
        filename: "voice_message.mp3",
        contentType: ttsResult.contentType,
        historyText: input.segment.historyText,
      };
    }

    const result = await input.sender(
      input.segment.text,
      effectiveReply({
        delivery: input.segment.delivery,
        defaultReply: input.reply,
        destinationChannelId,
        currentChannelId: input.currentChannelId,
      }),
      destinationChannelId,
      voice,
      input.signal,
      input.segment.delivery?.replyTo,
      input.attachments,
      discordSendDedupeKey({ requestLog: input.requestLog, sendId: input.sendId }),
    );
    assertSentMessageId(result);
    await input.onSent?.();
    const warnings = result.warnings ?? [];
    input.requestLog?.recordToolEnd(input.sendId, false, {
      content: [{
        type: "text",
        text: warnings.length > 0
          ? `Message sent.\nWarning: unknown emotes: ${warnings.join(", ")}`
          : "Message sent.",
      }],
      details: {
        sentMessageId: result.sentMessageId,
        ...(voice !== undefined ? { voiceGenerated: true } : {}),
        ...(input.attachments !== undefined && input.attachments.length > 0
          ? { attachments: input.attachments.map((attachment) => attachment.filename) }
          : {}),
        ...(warnings.length > 0 ? { unresolvedEmotes: warnings } : {}),
      },
    });
  } catch (error) {
    const errorText = makeToolErrorText(error);
    input.requestLog?.recordToolEnd(input.sendId, true, {
      content: [{ type: "text", text: errorText }],
    });
    if (isDiscordSendPermissionError(error)) return;
    throw error;
  }
}

async function sendResponseSegments(input: {
  sender: MessageSender;
  generateSpeech?: (text: string) => Promise<TtsResult>;
  ttsEnabled: boolean;
  segments: ResponseSegment[];
  replyFirst: boolean;
  sentOffset?: number;
  destinationChannelId?: string;
  currentChannelId?: string;
  requestLog?: RequestLog;
  log?: Logger;
  onStillWorking?: (channelId: string | undefined) => void | Promise<void>;
  getTypingStartedAt?: () => number;
  onVisibleOutput?: () => void;
  onSegmentSent?: (sent: { segment: DispatchSegment; hasMoreSegments: boolean }) => void | Promise<void>;
  currentChannelOutputAlreadySent?: boolean;
  onCurrentChannelOutput?: () => void;
  sendIdPrefix?: string;
  typingHoldMs?: number;
  typingHoldMsForSegment?: (segment: DispatchSegment) => number;
  signal?: AbortSignal;
  pendingAttachments?: OutboundAttachment[];
  resolveAssetAttachments?: AssetAttachmentResolver;
}): Promise<number> {
  let sent = input.sentOffset ?? 0;
  let sentNow = 0;
  let currentChannelOutputSent = input.currentChannelOutputAlreadySent === true;
  const dispatchSegments = buildDispatchSegments(input.segments);
  for (const segment of dispatchSegments) {
    sent += 1;
    sentNow += 1;
    const hasMoreSegments = sentNow < dispatchSegments.length;
    const segmentDestinationChannelId = segment.delivery?.channelId ?? input.destinationChannelId;
    const currentChannelDestination = isCurrentChannelDestination(segmentDestinationChannelId, input.currentChannelId);
    const useDefaultReply = input.replyFirst && currentChannelDestination && !currentChannelOutputSent;
    const pendingAttachments = input.pendingAttachments !== undefined && input.pendingAttachments.length > 0
      ? input.pendingAttachments.splice(0)
      : undefined;
    const referencedIds = segment.delivery?.assetIds;
    const referencedAttachments = referencedIds !== undefined && referencedIds.length > 0
      ? (await input.resolveAssetAttachments?.(referencedIds)) ?? []
      : [];
    const attachments = [
      ...(pendingAttachments ?? []),
      ...referencedAttachments,
    ];
    if (segment.kind === "text" && segment.text === "" && attachments.length === 0) {
      throw new Error("Cannot send <message>: it has no text and no referenced asset resolved.");
    }
    const sendId = `${input.sendIdPrefix ?? "final-send"}-${sent}`;
    const ensureTypingHoldBeforeSend = async (): Promise<void> => {
      const typingHoldMs = input.typingHoldMsForSegment?.(segment) ?? 0;
      if (typingHoldMs <= 0) return;
      let typingStartedAt = input.getTypingStartedAt?.() ?? 0;
      if (typingStartedAt <= 0) {
        await input.onStillWorking?.(segmentDestinationChannelId);
        typingStartedAt = input.getTypingStartedAt?.() ?? 0;
      }
      const elapsedTypingMs = typingStartedAt > 0 ? Date.now() - typingStartedAt : 0;
      await sleepMs(typingHoldMs - Math.max(0, elapsedTypingMs), input.signal);
    };
    const onSent = async (): Promise<void> => {
      input.onVisibleOutput?.();
      if (currentChannelDestination && !currentChannelOutputSent) {
        currentChannelOutputSent = true;
        input.onCurrentChannelOutput?.();
      }
      await input.onSegmentSent?.({ segment, hasMoreSegments });
      if (
        segment.delivery?.keepTyping === true
        && hasMoreSegments
        && input.typingHoldMsForSegment === undefined
      ) {
        await input.onStillWorking?.(segmentDestinationChannelId);
        await sleepMs(input.typingHoldMs ?? 0, input.signal);
      }
    };
    if (segment.kind === "text") {
      await ensureTypingHoldBeforeSend();
      await sendOneSegment({
        sender: input.sender,
        generateSpeech: input.generateSpeech,
        ttsEnabled: input.ttsEnabled,
        segment,
        sendId,
        reply: useDefaultReply,
        destinationChannelId: segmentDestinationChannelId,
        currentChannelId: input.currentChannelId,
        attachments: attachments.length > 0 ? attachments : undefined,
        requestLog: input.requestLog,
        signal: input.signal,
        onSent,
      });
      continue;
    }

    try {
      await ensureTypingHoldBeforeSend();
      await sendOneSegment({
        sender: input.sender,
        generateSpeech: input.generateSpeech,
        ttsEnabled: input.ttsEnabled,
        segment,
        sendId,
        reply: useDefaultReply,
        destinationChannelId: segmentDestinationChannelId,
        currentChannelId: input.currentChannelId,
        attachments: attachments.length > 0 ? attachments : undefined,
        requestLog: input.requestLog,
        signal: input.signal,
        onSent,
      });
    } catch (error) {
      input.log?.warn("voice directive failed; falling back to text", {
        error: makeToolErrorText(error),
      });
      await ensureTypingHoldBeforeSend();
      await sendOneSegment({
        sender: input.sender,
        generateSpeech: input.generateSpeech,
        ttsEnabled: input.ttsEnabled,
        segment: { kind: "text", text: segment.fallbackText, delivery: segment.delivery },
        sendId: `${sendId}-fallback`,
        reply: useDefaultReply,
        destinationChannelId: segmentDestinationChannelId,
        currentChannelId: input.currentChannelId,
        attachments: attachments.length > 0 ? attachments : undefined,
        requestLog: input.requestLog,
        signal: input.signal,
        onSent,
      });
    }
  }
  return sentNow;
}

interface LiveMessageDispatchDeps {
  sender: MessageSender;
  generateSpeech?: (text: string) => Promise<TtsResult>;
  ttsEnabled: boolean;
  replyFirst: boolean;
  destinationChannelId?: string;
  currentChannelId?: string;
  requestLog?: RequestLog;
  log?: Logger;
  onStillWorking?: (channelId: string | undefined) => void | Promise<void>;
  getTypingStartedAt?: () => number;
  onVisibleOutput?: () => void;
  typingHoldMs: number;
  typingHoldMsForSegment?: (segment: DispatchSegment) => number;
  signal?: AbortSignal;
  pendingAttachments?: OutboundAttachment[];
  resolveAssetAttachments?: AssetAttachmentResolver;
}

class LiveMessageDispatcher {
  private readonly deps: LiveMessageDispatchDeps;
  private buffer = "";
  private consumedUntil = 0;
  private sent = 0;
  private currentChannelOutputSent = false;
  private disabled = false;
  private gapTypingSent = false;
  private gapTypingReadyAt = 0;

  constructor(deps: LiveMessageDispatchDeps) {
    this.deps = deps;
  }

  sentCount(): number {
    return this.sent;
  }

  /**
   * Start a fresh provider stream while preserving how many Discord messages
   * earlier model turns already emitted in this agent loop.
   */
  startModelTurn(): void {
    this.buffer = "";
    this.consumedUntil = 0;
    this.disabled = false;
    this.clearGapTyping();
  }

  async push(delta: string): Promise<void> {
    if (delta === "" || this.disabled) return;
    this.buffer += delta;
    await this.flushCompleteEnvelopes({ notifyTyping: true });
  }

  async finish(finalText: string): Promise<number> {
    if (this.disabled || this.sent === 0) return this.sent;
    const consumedPrefix = this.buffer.slice(0, this.consumedUntil);
    if (!finalText.startsWith(consumedPrefix)) {
      const parsed = parseResponseDirectives(finalText);
      if (!parsed.ignored && parsed.segments.length > 0) {
        this.sent += await sendResponseSegments({
          ...this.deps,
          segments: parsed.segments,
          sentOffset: this.sent,
          replyFirst: this.deps.replyFirst,
          currentChannelOutputAlreadySent: this.currentChannelOutputSent,
          onCurrentChannelOutput: () => { this.currentChannelOutputSent = true; },
          onStillWorking: this.deps.typingHoldMsForSegment === undefined ? undefined : this.deps.onStillWorking,
        });
      }
      return this.sent;
    }
    this.buffer = finalText;
    await this.flushCompleteEnvelopes({ notifyTyping: false });
    const remainder = this.buffer.slice(this.consumedUntil).trim();
    if (remainder !== "") {
      const parsed = parseResponseDirectives(remainder);
      if (!parsed.ignored && parsed.segments.length > 0) {
        this.sent += await sendResponseSegments({
          ...this.deps,
          segments: parsed.segments,
          sentOffset: this.sent,
          replyFirst: this.deps.replyFirst,
          currentChannelOutputAlreadySent: this.currentChannelOutputSent,
          onCurrentChannelOutput: () => { this.currentChannelOutputSent = true; },
          onStillWorking: this.deps.typingHoldMsForSegment === undefined ? undefined : this.deps.onStillWorking,
        });
      }
      this.consumedUntil = this.buffer.length;
    }
    return this.sent;
  }

  private async flushCompleteEnvelopes(input: { notifyTyping: boolean }): Promise<void> {
    for (;;) {
      const cursor = this.skipWhitespace(this.consumedUntil);
      if (this.buffer.slice(cursor).toLowerCase().startsWith("<ignore")) {
        if (this.sent > 0) {
          const ignoredEnd = this.completeIgnoreDirectiveEnd(cursor);
          if (ignoredEnd === null) return;
          this.consumedUntil = ignoredEnd;
          continue;
        }
        this.disabled = true;
        return;
      }
      if (!this.buffer.slice(cursor).toLowerCase().startsWith("<message")) {
        return;
      }

      const tagEnd = this.buffer.indexOf(">", cursor);
      if (tagEnd === -1) return;

      const closeStart = this.buffer.toLowerCase().indexOf("</message>", tagEnd + 1);
      if (closeStart === -1) {
        if (input.notifyTyping && this.sent > 0) {
          await this.notifyTypingForGap();
        }
        return;
      }

      const closeEnd = closeStart + "</message>".length;
      const rawEnvelope = this.buffer.slice(cursor, closeEnd);
      const parsed = parseResponseDirectives(rawEnvelope);
      if (!parsed.ignored && parsed.segments.length > 0) {
        if (this.deps.typingHoldMsForSegment === undefined) await this.waitForGapTypingHold();
        this.clearGapTyping();
        const typeAfterMessage = input.notifyTyping
          && (messageWantsTyping(parsed.segments) || this.nextMessageHasStarted(closeEnd));
        this.sent += await sendResponseSegments({
          ...this.deps,
          segments: parsed.segments,
          sentOffset: this.sent,
          replyFirst: this.deps.replyFirst,
          currentChannelOutputAlreadySent: this.currentChannelOutputSent,
          onCurrentChannelOutput: () => { this.currentChannelOutputSent = true; },
          onStillWorking: this.deps.typingHoldMsForSegment === undefined ? undefined : this.deps.onStillWorking,
          onSegmentSent: async ({ hasMoreSegments }) => {
            if (!hasMoreSegments && typeAfterMessage) await this.notifyTypingForGap();
          },
        });
      }
      this.consumedUntil = closeEnd;
    }
  }

  private async notifyTypingForGap(): Promise<void> {
    if (this.gapTypingSent) return;
    this.gapTypingSent = true;
    await this.deps.onStillWorking?.(this.deps.destinationChannelId);
    this.gapTypingReadyAt = Date.now() + this.deps.typingHoldMs;
  }

  private async waitForGapTypingHold(): Promise<void> {
    if (!this.gapTypingSent) return;
    await sleepMs(this.gapTypingReadyAt - Date.now(), this.deps.signal);
  }

  private clearGapTyping(): void {
    this.gapTypingSent = false;
    this.gapTypingReadyAt = 0;
  }

  private nextMessageHasStarted(index: number): boolean {
    const cursor = this.skipWhitespace(index);
    return this.buffer.slice(cursor).toLowerCase().startsWith("<message");
  }

  private skipWhitespace(index: number): number {
    let cursor = index;
    while (cursor < this.buffer.length && /\s/.test(this.buffer[cursor] ?? "")) {
      cursor += 1;
    }
    return cursor;
  }

  private completeIgnoreDirectiveEnd(index: number): number | null {
    const tagEnd = this.buffer.indexOf(">", index);
    if (tagEnd === -1) return null;
    const rawTag = this.buffer.slice(index, tagEnd + 1);
    if (/\/\s*>$/.test(rawTag)) return tagEnd + 1;
    const closeStart = this.buffer.toLowerCase().indexOf("</ignore>", tagEnd + 1);
    return closeStart === -1 ? null : closeStart + "</ignore>".length;
  }
}

function messageWantsTyping(segments: ResponseSegment[]): boolean {
  for (const segment of segments) {
    if (segment.kind === "messageBreak" && segment.delivery?.keepTyping === true) return true;
  }
  return false;
}

function memoryPassControlMessage(input: SilentMemoryAgentInput): string {
  const now = Date.now();
  const passKind = input.passKind ?? "post_reply";
  const maxToolCalls = input.guildConfig.memoryExtraction.maxToolCalls;
  const executionMode = runtimeContextTemplate(
    input.runtimePrompts,
    "memory-maintenance-execution-mode",
    { maxToolCalls },
    [
      "## Execution Mode: Memory Maintenance",
      "Private memory maintenance is active. Read-only tools are optionally available when they would materially reduce uncertainty; record_memory is the only state-changing tool available.",
      "Submit every useful memory edit as one complete record_memory action list. Retry only if the tool reports an error, and retry only the failed work.",
      "If there are no memory changes, do not call record_memory; output nothing.",
    ].join("\n"),
  );
  const triggerContext = [
    passKind === "ambient"
      ? "## Memory Maintenance Review — Periodic Trigger"
      : "## Memory Maintenance Review — Post-Reply Trigger",
    "Current time for expiresIn decisions:",
    currentLocalContext(input.guildConfig.timezone, now),
  ].join("\n");
  return [
    input.visibleUserMemoryContext?.trim() ?? "",
    executionMode,
    triggerContext,
    passKind === "ambient"
      ? runtimeContextTemplate(
        input.runtimePrompts,
        "memory-pass-ambient-review",
        {},
        "Review ambient chat history for durable memory.",
      )
      : "",
    runtimeContextTemplate(
      input.runtimePrompts,
      "memory-pass-decision",
      {},
      "Decide silently whether durable memory should be updated.",
    ),
  ].filter((part) => part !== "").join("\n\n");
}

/** Run a hidden post-reply maintenance loop with private tools and no Discord output hooks. */
export async function runSilentToolAgentPass(input: SilentToolAgentInput): Promise<void> {
  if (input.tools.length === 0) return;

  const wallController = new AbortController();
  const parent = input.signal;
  let onParentAbort: (() => void) | undefined;
  if (parent !== undefined) {
    if (parent.aborted) {
      throw parent.reason instanceof Error ? parent.reason : new Error("Silent memory pass aborted");
    }
    onParentAbort = () => wallController.abort(parent.reason);
    parent.addEventListener("abort", onParentAbort, { once: true });
  }
  const wallTimeout = setTimeout(() => {
    wallController.abort(new AgentTimeBudgetExceededError(input.guildConfig.replyLoop.wallClockTimeoutMs));
  }, input.guildConfig.replyLoop.wallClockTimeoutMs);

  const complete = input.completeChat ?? completeLlmChat;
  const inheritedPrompt = input.promptContext;
  const profileId = input.modelProfile ?? input.guildConfig.modelProfile;
  const profile = resolveModelProfile(input.globalConfig, profileId);
  const model = resolveModelProfileModel(input.globalConfig, profileId);
  const provider = profile.provider;
  const inheritedPromptCompatible = inheritedPrompt?.provider === provider
    && inheritedPrompt.model === model.id;
  const transport = inheritedPromptCompatible
    ? inheritedPrompt.transport
    : promptTransportForProvider(input.guildConfig.promptTransport, provider);
  const streamOptions = buildModelProfileStreamOptions(input.globalConfig, profileId);
  const providerParams: Record<string, unknown> = { ...streamOptions };
  delete providerParams.apiKey;
  delete providerParams.signal;
  delete providerParams.onPayload;
  const promptCaching = profile.promptCaching;
  const maintenanceToolSignature = toolContractSignature(input.tools);
  if (inheritedPromptCompatible
    && inheritedPrompt.toolContractSignature !== undefined
    && inheritedPrompt.toolContractSignature !== maintenanceToolSignature) {
    throw new Error("Maintenance tool contract diverged from the actor turn; refusing a cache-breaking continuation.");
  }

  const stableSections = inheritedPromptCompatible ? inheritedPrompt.stableSections : sectionsForStablePrompt(
    input.systemPrompt ?? "",
    input.personaPrompt ?? "",
    "",
    input.context,
    "",
    input.runtimeInstruction,
    transport,
  );
  const sessionId = inheritedPromptCompatible
    ? inheritedPrompt.sessionId
    : buildProviderSessionId(input.requestLog, `${provider}:${model.id}`);
  const promptCacheKey = inheritedPromptCompatible
    ? inheritedPrompt.promptCacheKey
    : provider === "openai-codex"
      ? promptCaching.enabled
        ? buildCodexPromptCacheKey(
            input.globalConfig.runtimeProfileId ?? "default",
            profileId,
            model.id,
            "discord-actor",
          )
        : ""
      : undefined;
  const currentMessageWithoutImages: IncomingMessage = { ...input.incomingMessage, imageInputs: undefined };
  const volatileMessages = buildVolatileTurnMessages(input.context);
  const initialRoles = inheritedPromptCompatible
    ? inheritedPrompt.initialRoles
    : initialMessageRoles(transport, volatileMessages);
  const messages = (inheritedPromptCompatible ? input.transcript : undefined) ?? buildInitialMessages(
    input.userContent,
    volatileMessages,
    currentMessageWithoutImages,
    input.runtimePrompts,
    provider === "openai-codex" ? [] : initialRoles,
  );
  if (!inheritedPromptCompatible) {
    const actorEvidence = portableActorTurnEvidence(input.transcript, input.assistantReply);
    if (actorEvidence !== "") {
      messages.push({
        role: "user",
        content: `## Completed Actor Turn Evidence\n${actorEvidence}`,
      });
    }
  }
  messages.push({ role: "user", content: input.controlMessage });

  const { tools: timedTools, state: timingState } = wrapToolsWithTiming(input.tools);
  const maxToolCalls = Math.max(1, input.maxToolCalls ?? input.tools.length);
  timingState.resetAgentLoopStart();
  try {
    await runNativeToolLoop({
      complete,
      requestBase: {
        provider,
        apiKey: streamOptions.apiKey,
        model: model.id,
        systemPrompt: provider === "openai-codex" ? codexSystemPromptForStableSections(stableSections, transport) : "",
        providerParams,
        sessionId,
        promptCacheKey,
        onPayload: (payload: unknown) => {
          if (provider === "openrouter") {
            prependStableSectionsToPayload(
              payload,
              stableSections,
              promptCaching,
              model.id,
            );
          } else if (transport.mode === "split-input") {
            prependStableSectionsToCodexPayload(payload, stableSections, initialRoles, {
              enabled: promptCaching.enabled,
              promptCacheKey,
            });
          }
          input.requestLog?.recordLLMRequest(payload);
          input.log?.debug("memory_llm_request_payload", { payload });
        },
      },
      messages,
      tools: timedTools,
      maxToolCalls,
      maxToolRounds: input.maxToolCalls !== undefined
        ? maxToolCalls
        : Math.min(input.guildConfig.replyLoop.maxToolCalls, 3),
      agentTimeBudgetMs: input.guildConfig.replyLoop.wallClockTimeoutMs,
      llmOutputTimeoutMs: input.guildConfig.replyLoop.llmOutputTimeoutMs,
      requestLog: input.requestLog,
      imageInputSupported: false,
      pendingAttachments: [],
      toolTiming: timingState,
      runtimePrompts: input.runtimePrompts,
      log: input.log,
      signal: wallController.signal,
      allowEmptyFinalResponse: true,
      stopOnAgentTimeBudget: true,
      terminateAfterSuccessfulToolRoundNames: input.terminateAfterSuccessfulToolRoundNames,
    });
  } finally {
    clearTimeout(wallTimeout);
    if (parent !== undefined && onParentAbort !== undefined) {
      parent.removeEventListener("abort", onParentAbort);
    }
  }
}

/** Run the post-reply memory maintenance loop with only memory tools and no Discord output hooks. */
export async function runSilentMemoryAgentPass(input: SilentMemoryAgentInput): Promise<void> {
  await runSilentToolAgentPass({
    ...input,
    runtimeInstruction: buildRuntimeInstruction(input.runtimePrompts),
    controlMessage: memoryPassControlMessage(input),
    modelProfile: input.guildConfig.memoryExtraction.modelProfile,
    maxToolCalls: input.guildConfig.memoryExtraction.maxToolCalls,
    terminateAfterSuccessfulToolRoundNames: ["record_memory"],
  });
}

/**
 * Core message handler. Evaluates triggers, runs a native tool-calling persona reply,
 * sends the final Discord text, then optionally schedules background memory extraction.
 */
export async function handleMessage(
  msg: IncomingMessage,
  deps: HandlerDeps
): Promise<HandleResult> {
  let triggerResult: TriggerResult;

  if (deps.triggerOverride !== undefined) {
    triggerResult = deps.triggerOverride;
  } else if (deps.forceTrigger === true) {
    triggerResult = { reason: "scheduled" };
  } else {
    const triggerInput: TriggerInput = {
      content: msg.content,
      authorId: msg.authorId,
      authorIsBot: msg.authorIsBot,
      botUserId: msg.botUserId,
      mentionedUserIds: msg.mentionedUserIds,
      mentionedRoleIds: msg.mentionedRoleIds,
      botRoleIds: msg.botRoleIds,
      mentionedEveryone: msg.mentionedEveryone,
      repliedToBot: msg.repliedToBot,
    };

    triggerResult = shouldRespond(triggerInput, deps.guildConfig.triggers);
    if (triggerResult === null) {
      return { triggered: false, triggerResult: null, agentRan: false };
    }
  }

  deps.onTriggered?.(triggerResult);

  const context = deps.context;

  const profileId = deps.modelProfile ?? deps.guildConfig.modelProfile;
  const profile = resolveModelProfile(deps.globalConfig, profileId);
  const model = resolveModelProfileModel(deps.globalConfig, profileId);
  const baseStreamOptions = buildModelProfileStreamOptions(deps.globalConfig, profileId);
  const providerParams: Record<string, unknown> = { ...baseStreamOptions };
  delete providerParams.apiKey;
  delete providerParams.signal;
  delete providerParams.onPayload;
  const imageProfile = resolveModelProfile(
    deps.globalConfig,
    deps.guildConfig.imageReading.fallbackModelProfile,
  );
  const imageStreamOptions = deps.guildConfig.imageReading.fallbackEnabled
    ? buildModelProfileStreamOptions(
      deps.globalConfig,
      deps.guildConfig.imageReading.fallbackModelProfile,
    )
    : { apiKey: "" };
  const imageProviderParams: Record<string, unknown> = { ...imageStreamOptions };
  delete imageProviderParams.apiKey;
  delete imageProviderParams.signal;
  delete imageProviderParams.onPayload;

  const skillTool = deps.runtimePrompts !== undefined && Object.keys(deps.runtimePrompts.skills.byId).length > 0
    ? [createLoadSkillTool({ skills: deps.runtimePrompts.skills })]
    : [];
  const tools = [...skillTool, ...(deps.extraTools ?? [])];
  const { tools: timedTools, state: timingState } = wrapToolsWithTiming(tools);
  const complete = deps.completeChat ?? completeLlmChat;
  const runtimeInstruction = buildRuntimeInstruction(deps.runtimePrompts);
  const transport = promptTransportForProvider(deps.guildConfig.promptTransport, model.llmProvider);
  const stableSections = sectionsForStablePrompt(
    deps.systemPrompt ?? "",
    deps.personaPrompt ?? "",
    "",
    context,
    buildSkillsInstruction(deps.runtimePrompts),
    runtimeInstruction,
    transport,
  );
  const userContent = context.userMessage !== "" ? context.userMessage : msg.translatedContent;
  const volatileMessages = buildVolatileTurnMessages(context);
  const finalActionInstruction = buildFinalActionInstruction(deps.runtimePrompts, deps.scheduledTaskRun === true);
  const initialRoles = initialMessageRoles(transport, volatileMessages, finalActionInstruction !== "");
  const reqLog = deps.requestLog;
  const visibleToolSignature = toolContractSignature(tools);
  const sessionId = buildProviderSessionId(reqLog, `${model.llmProvider}:${model.id}`);
  const promptCacheKey = model.llmProvider === "openai-codex"
    ? profile.promptCaching.enabled
      ? buildCodexPromptCacheKey(
          deps.globalConfig.runtimeProfileId ?? "default",
          profileId,
          model.id,
          "discord-actor",
        )
      : ""
    : undefined;
  const maintenancePromptContext: MaintenancePromptContext = {
    provider: model.llmProvider,
    model: model.id,
    transport,
    stableSections,
    initialRoles,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(promptCacheKey !== undefined ? { promptCacheKey } : {}),
    promptCaching: profile.promptCaching,
    toolContractSignature: visibleToolSignature,
  };
  const startedAt = Date.now();
  let maintenanceTranscript: OpenRouterMessage[] | undefined;
  let finalText = "";
  let finalStopReason: string | undefined;
  const scheduleMemoryPass = (assistantReply: string, visibleReplySent: boolean): void => {
    const task = deps.afterReply?.({
      sourceMessageId: msg.messageId,
      userMessage: userContent,
      assistantReply,
      recentContext: memoryExtractionContext(context),
      context,
      incomingMessage: msg,
      visibleReplySent,
      maintenanceTranscript,
      availableTools: tools,
      promptContext: maintenancePromptContext,
    }).catch((error: unknown) => {
      deps.log?.warn("memory extraction failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    if (task === undefined) return;
    deps.trackBackgroundTask?.(task);
    void task;
  };

  try {
    deps.log?.debug("native_reply_loop_start", {
      model: model.id,
      modelImageInputSupport: deps.modelImageInputSupport ?? "registry",
      toolNames: timedTools.map((tool) => tool.name),
      maxToolCalls: deps.guildConfig.replyLoop.maxToolCalls,
      wallClockTimeoutMs: deps.guildConfig.replyLoop.wallClockTimeoutMs,
      llmOutputTimeoutMs: deps.guildConfig.replyLoop.llmOutputTimeoutMs,
    });

    const wallController = new AbortController();
    const onCallerAbort = (): void => wallController.abort(deps.abortSignal?.reason);
    if (deps.abortSignal?.aborted === true) {
      wallController.abort(deps.abortSignal.reason);
    } else {
      deps.abortSignal?.addEventListener("abort", onCallerAbort, { once: true });
    }
    const wallTimeout = setTimeout(() => {
      wallController.abort(new AgentTimeBudgetExceededError(deps.guildConfig.replyLoop.wallClockTimeoutMs));
    }, deps.guildConfig.replyLoop.wallClockTimeoutMs);

    const pendingAttachments: OutboundAttachment[] = [];
    const intermediateStatus = { sent: false, sendCount: 0 };
    let visibleOutputDelivered = false;
    const noteVisibleOutput = (): void => {
      visibleOutputDelivered = true;
      deps.onVisibleOutput?.();
    };
    const hasVisibleOutput = (): boolean => visibleOutputDelivered || deps.hasExternalVisibleOutput?.() === true;
    const replyFirst = false;
    const liveMessageTypingHoldMs = deps.liveMessageTypingHoldMs ?? DEFAULT_LIVE_MESSAGE_TYPING_HOLD_MS;
    const typingHoldMsForSegment = deps.guildConfig.typingSimulation.enabled
      ? (segment: DispatchSegment): number => typingSimulationDelayMs(
        deps.guildConfig.typingSimulation,
        "output",
        segment.kind === "voice" ? segment.historyText : segment.text,
      )
      : undefined;
    const liveDispatchers = new Map<string, LiveMessageDispatcher>();
    const liveDispatcherFor = (destinationChannelId: string | undefined): LiveMessageDispatcher => {
      const key = destinationChannelId ?? "";
      const existing = liveDispatchers.get(key);
      if (existing !== undefined) return existing;
      const dispatcher = new LiveMessageDispatcher({
        sender: deps.sender,
        generateSpeech: deps.generateSpeech,
        ttsEnabled: deps.ttsEnabled ?? false,
        replyFirst: !hasVisibleOutput() && replyFirst,
        destinationChannelId,
        currentChannelId: deps.currentChannelId,
        requestLog: reqLog,
        log: deps.log,
        onStillWorking: deps.onStillWorking,
        getTypingStartedAt: deps.getTypingStartedAt,
        onVisibleOutput: noteVisibleOutput,
        typingHoldMs: liveMessageTypingHoldMs,
        typingHoldMsForSegment,
        signal: wallController.signal,
        pendingAttachments,
        resolveAssetAttachments: deps.resolveAssetAttachments,
      });
      liveDispatchers.set(key, dispatcher);
      return dispatcher;
    };
    const sendIntermediateStatus = async (text: string, destinationChannelId: string | undefined): Promise<boolean> => {
      const parsed = parseResponseDirectives(text);
      if (parsed.ignored || parsed.segments.length === 0) return false;
      intermediateStatus.sendCount += 1;
      try {
        intermediateStatus.sendCount = await sendResponseSegments({
          sender: deps.sender,
          generateSpeech: deps.generateSpeech,
          ttsEnabled: deps.ttsEnabled ?? false,
          segments: parsed.segments,
          replyFirst: !hasVisibleOutput() && replyFirst,
          sentOffset: intermediateStatus.sendCount - 1,
          destinationChannelId,
          currentChannelId: deps.currentChannelId,
          requestLog: reqLog,
          log: deps.log,
          onStillWorking: deps.onStillWorking,
          getTypingStartedAt: deps.getTypingStartedAt,
          onVisibleOutput: noteVisibleOutput,
          sendIdPrefix: "tool-status",
          typingHoldMs: liveMessageTypingHoldMs,
          typingHoldMsForSegment,
          signal: wallController.signal,
        });
        intermediateStatus.sent = true;
        return true;
      } catch (error) {
        deps.log?.warn("intermediate tool status send failed", {
          error: makeToolErrorText(error),
        });
        return false;
      }
    };
    try {
      timingState.resetAgentLoopStart();
      const mainMessages = buildInitialMessages(
        userContent,
        volatileMessages,
        msg,
        deps.runtimePrompts,
        model.llmProvider === "openai-codex" ? [] : initialRoles,
        finalActionInstruction,
      );
      maintenanceTranscript = mainMessages;
      const result = await runNativeToolLoop({
        complete,
        requestBase: {
          provider: model.llmProvider,
          apiKey: baseStreamOptions.apiKey,
          model: model.id,
          systemPrompt: model.llmProvider === "openai-codex"
            ? codexSystemPromptForStableSections(stableSections, transport)
            : "",
          providerParams,
          sessionId,
          promptCacheKey,
          onPayload: (payload: unknown) => {
            if (model.llmProvider === "openrouter") {
              prependStableSectionsToPayload(payload, stableSections, profile.promptCaching, model.id);
            } else if (transport.mode === "split-input") {
            prependStableSectionsToCodexPayload(payload, stableSections, initialRoles, {
              enabled: profile.promptCaching.enabled,
              promptCacheKey,
            });
            }
            reqLog?.recordLLMRequest(payload);
            deps.log?.debug("llm_request_payload", { payload });
          },
        },
        messages: mainMessages,
        tools: timedTools,
        maxToolCalls: deps.guildConfig.replyLoop.maxToolCalls,
        maxToolRounds: deps.guildConfig.replyLoop.maxToolCalls,
        agentTimeBudgetMs: deps.guildConfig.replyLoop.wallClockTimeoutMs,
        llmOutputTimeoutMs: deps.guildConfig.replyLoop.llmOutputTimeoutMs,
        requestLog: reqLog,
        sendIntermediateText: deps.externalResponseSink !== undefined || deps.disableLiveOutput === true
          ? undefined
          : sendIntermediateStatus,
        streamFinalText: deps.externalResponseSink !== undefined
          ? async (delta) => await deps.externalResponseSink?.push(delta) ?? false
          : deps.disableLiveOutput === true
          ? undefined
          : async (delta, destinationChannelId) => {
            const dispatcher = liveDispatcherFor(destinationChannelId);
            const before = dispatcher.sentCount();
            await dispatcher.push(delta);
            const sent = dispatcher.sentCount() > before;
            if (sent) intermediateStatus.sent = true;
            return sent;
          },
        onModelTurnStart: (destinationChannelId) => {
          deps.externalResponseSink?.startModelTurn();
          liveDispatchers.get(destinationChannelId ?? "")?.startModelTurn();
        },
        onStillWorking: deps.onStillWorking,
        hasExternalVisibleOutput: deps.hasExternalVisibleOutput,
        currentChannelId: deps.currentChannelId,
        imageInputSupported: supportsNativeImageInput(model.input, deps.modelImageInputSupport),
        toolTiming: timingState,
        log: deps.log,
        imageFallback: {
          enabled: deps.guildConfig.imageReading.fallbackEnabled,
          model: imageProfile.model,
          provider: imageProfile.provider,
          apiKey: imageStreamOptions.apiKey,
          providerParams: imageProviderParams,
          complete,
          llmOutputTimeoutMs: deps.guildConfig.replyLoop.llmOutputTimeoutMs,
          imageDescriptionSystemPrompt: deps.runtimePrompts?.imageDescriptionSystemPrompt,
          requestLog: reqLog,
          signal: wallController.signal,
          log: deps.log,
        },
        consumeGeneratedAttachments: deps.consumeGeneratedAttachments,
        pendingAttachments,
        runtimePrompts: deps.runtimePrompts,
        allowEmptyFinalResponse: deps.hasExternalVisibleOutput,
        correctInvalidMessageDirectives: true,
        signal: wallController.signal,
      });
      finalText = result.text;
      finalStopReason = result.stopReason;
    } finally {
      clearTimeout(wallTimeout);
      deps.abortSignal?.removeEventListener("abort", onCallerAbort);
    }

    if (finalStopReason === "length") {
      deps.log?.warn("native reply blocked after incomplete model output", {
        stopReason: finalStopReason,
        outputLength: finalText.length,
        visibleOutputAlreadySent: hasVisibleOutput()
          || [...liveDispatchers.values()].some((dispatcher) => dispatcher.sentCount() > 0),
      });
      return { triggered: true, triggerResult, agentRan: true, maintenanceTranscript, availableTools: tools, promptContext: maintenancePromptContext };
    }

    if (deps.externalResponseSink !== undefined) {
      const external = await deps.externalResponseSink.finish(finalText);
      if (external.malformed) {
        deps.log?.warn("external response blocked after malformed private output", {
          outputLength: finalText.length,
        });
      }
      scheduleMemoryPass(external.memoryText, external.visible);
      return {
        triggered: true,
        triggerResult,
        agentRan: true,
        responseText: external.memoryText,
        maintenanceTranscript,
        availableTools: tools,
        promptContext: maintenancePromptContext,
      };
    }

    const parsedResponse = parseResponseDirectives(finalText);
    if (parsedResponse.directiveErrors !== undefined) {
      deps.log?.warn("native reply blocked after invalid message directive", {
        errors: parsedResponse.directiveErrors,
      });
      return { triggered: true, triggerResult, agentRan: true, maintenanceTranscript, availableTools: tools, promptContext: maintenancePromptContext };
    }
    if (parsedResponse.malformedPrivateOutput === true) {
      deps.log?.warn("native reply blocked after malformed private output", {
        outputLength: finalText.length,
      });
      return { triggered: true, triggerResult, agentRan: true, maintenanceTranscript, availableTools: tools, promptContext: maintenancePromptContext };
    }
    if (parsedResponse.ignored) {
      if (parsedResponse.ignoredText !== undefined) {
        try {
          await deps.onIgnoredReply?.({
            sourceMessageId: msg.messageId,
            channelId: deps.currentChannelId,
            historyText: parsedResponse.ignoredText,
            rawResponse: finalText,
          });
        } catch (error) {
          deps.log?.warn("ignored reply persistence failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      scheduleMemoryPass(parsedResponse.ignoredText ?? finalText, hasVisibleOutput());
      deps.log?.debug("native_reply_ignored", { durationMs: Date.now() - startedAt });
      return {
        triggered: true,
        triggerResult,
        agentRan: true,
        ...(parsedResponse.privateThoughts !== undefined ? { privateThoughts: parsedResponse.privateThoughts } : {}),
        maintenanceTranscript,
        availableTools: tools,
        promptContext: maintenancePromptContext,
      };
    }
    if (parsedResponse.segments.length === 0) {
      scheduleMemoryPass("", hasVisibleOutput());
      deps.log?.debug("native_reply_empty_after_directives", { durationMs: Date.now() - startedAt });
      return {
        triggered: true,
        triggerResult,
        agentRan: true,
        ...(parsedResponse.privateThoughts !== undefined ? { privateThoughts: parsedResponse.privateThoughts } : {}),
        maintenanceTranscript,
        availableTools: tools,
        promptContext: maintenancePromptContext,
      };
    }
    if (deps.preSendCheck !== undefined && !await deps.preSendCheck(finalText)) {
      deps.log?.debug("native_reply_dropped_before_send", { durationMs: Date.now() - startedAt });
      return {
        triggered: true,
        triggerResult,
        agentRan: true,
        ...(parsedResponse.privateThoughts !== undefined ? { privateThoughts: parsedResponse.privateThoughts } : {}),
        maintenanceTranscript,
        availableTools: tools,
        promptContext: maintenancePromptContext,
      };
    }

    const liveSent = await (liveDispatchers.get("")?.finish(finalText) ?? Promise.resolve(0));
    if (liveSent === 0) {
      await sendResponseSegments({
        sender: deps.sender,
        generateSpeech: deps.generateSpeech,
        ttsEnabled: deps.ttsEnabled ?? false,
        segments: parsedResponse.segments,
        replyFirst: !hasVisibleOutput() && replyFirst,
        currentChannelId: deps.currentChannelId,
        requestLog: reqLog,
        log: deps.log,
        onStillWorking: deps.onStillWorking,
        getTypingStartedAt: deps.getTypingStartedAt,
        onVisibleOutput: noteVisibleOutput,
        typingHoldMs: liveMessageTypingHoldMs,
        typingHoldMsForSegment,
        signal: wallController.signal.aborted ? undefined : wallController.signal,
        pendingAttachments,
        resolveAssetAttachments: deps.resolveAssetAttachments,
      });
    }

    const memoryReply = renderSegmentsForMemory(parsedResponse.segments);
    scheduleMemoryPass(memoryReply, hasVisibleOutput());

    deps.log?.debug("native_reply_loop_end", {
      durationMs: Date.now() - startedAt,
      outputLength: memoryReply.length,
    });
    return {
      triggered: true,
      triggerResult,
      agentRan: true,
      responseText: memoryReply,
      ...(parsedResponse.privateThoughts !== undefined ? { privateThoughts: parsedResponse.privateThoughts } : {}),
      maintenanceTranscript,
      availableTools: tools,
      promptContext: maintenancePromptContext,
    };
  } finally {
    deps.onAgentEnd?.();
  }
}
