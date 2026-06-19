import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { validateToolArguments, type ToolCall } from "@mariozechner/pi-ai";
import { createHash } from "node:crypto";
import { shouldRespond, type TriggerInput, type TriggerResult } from "./triggers.ts";
import { contextToSplitPrompts, type AssembledContext, type ContextSection } from "./context-assembly.ts";
import { wrapToolsWithTiming, type TimingState } from "./tool-timing.ts";
import type { LlmProvider, TriggerInstructions } from "../config/types.ts";
import type { TtsResult } from "../tts/types.ts";
import { resolveGuildModel, buildStreamOptions, buildBackgroundStreamOptions, buildImageReadingStreamOptions, type ModelImageInputSupport } from "../llm/client.ts";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";
import type { Logger, RequestLog } from "../logger.ts";
import {
  completeLlmChat,
  type OpenRouterChatRequest,
  type OpenRouterChatResult,
  type OpenRouterImageUrlPart,
  type OpenRouterMessage,
  type OpenRouterTextPart,
  type OpenRouterToolCall,
  type OpenRouterToolDefinition,
} from "../llm/openrouter-chat.ts";
import {
  getStablePromptSections,
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

/** Minimal abstraction over a Discord message for the handler. */
export interface IncomingMessage {
  content: string;
  authorId: string;
  authorUsername: string;
  botUserId: string;
  mentionedUserIds: string[];
  translatedContent: string;
  messageId?: string;
  replyToMessageId?: string;
  imageInputs?: CurrentTurnImageInput[];
}

export type ChatCompleteFn = (request: OpenRouterChatRequest) => Promise<OpenRouterChatResult>;

export interface MemoryExtractionRequest {
  sourceMessageId?: string;
  userMessage: string;
  assistantReply: string;
  recentContext: string;
  context: AssembledContext;
  incomingMessage: IncomingMessage;
  visibleReplySent: boolean;
}

export interface SilentMemoryAgentInput {
  globalConfig: GlobalConfig;
  guildConfig: GuildConfig;
  context: AssembledContext;
  personaPrompt?: string;
  incomingMessage: IncomingMessage;
  userContent: string;
  assistantReply: string;
  visibleReplySent: boolean;
  tools: AgentTool[];
  log?: Logger;
  requestLog?: RequestLog;
  completeChat?: ChatCompleteFn;
  signal?: AbortSignal;
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
  historyText?: string;
}

/** Image bytes attached to the current synthetic or live turn for native model vision. */
export interface CurrentTurnImageInput {
  buffer: Buffer;
  contentType: string;
  metadataText?: string;
}

/** Callback that performs the actual Discord send. */
export type MessageSender = (
  text: string,
  reply: boolean,
  chatId: string | undefined,
  voice?: VoiceAttachment,
  signal?: AbortSignal,
  replyToMessageId?: string,
  attachments?: OutboundAttachment[],
  dedupeKey?: string,
) => Promise<{ sentMessageId: string; warnings?: string[] }>;

/** Dependencies injected into the handler. No direct discord.js coupling. */
export interface HandlerDeps {
  globalConfig: GlobalConfig;
  guildConfig: GuildConfig;
  context: AssembledContext;
  personaPrompt?: string;
  sender: MessageSender;
  /** Native OpenRouter tools exposed to the model. */
  extraTools?: AgentTool[];
  log?: Logger;
  onTriggered?: (result: NonNullable<TriggerResult>) => void;
  /** Called when work continues after a user-visible message so typing can be sent before later output. */
  onStillWorking?: (targetChatId: string | undefined) => void | Promise<void>;
  /** Called after user-visible output starts so continuous background typing can stop. */
  onVisibleOutput?: () => void;
  /** Minimum visible typing time before a buffered streamed follow-up message is sent. */
  liveMessageTypingHoldMs?: number;
  onAgentEnd?: () => void;
  requestLog?: RequestLog;
  ttsEnabled?: boolean;
  generateSpeech?: (text: string) => Promise<TtsResult>;
  forceTrigger?: boolean;
  triggerOverride?: NonNullable<TriggerResult>;
  triggerInstructions?: TriggerInstructions;
  completeChat?: ChatCompleteFn;
  afterReply?: (request: MemoryExtractionRequest) => Promise<void>;
  /** Live OpenRouter metadata result for the selected main model. Unknown means try native image input first. */
  modelImageInputSupport?: ModelImageInputSupport;
  /** Consume generated image attachments by opaque IDs returned from image tools. */
  consumeGeneratedAttachments?: (ids: string[]) => OutboundAttachment[];
  /** Attachments already produced before this reply loop; sent with the first visible message. */
  initialPendingAttachments?: OutboundAttachment[];
}

export interface HandleResult {
  triggered: boolean;
  triggerResult: TriggerResult;
  agentRan: boolean;
  responseText?: string;
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

/**
 * Inject a trigger-specific instruction into context sections.
 * Inserts before the volatile response instruction section if present.
 * @internal Exported for testing.
 */
export function injectTriggerInstruction(
  sections: ContextSection[],
  instruction: string
): ContextSection[] {
  const newSection: ContextSection = {
    label: "Trigger Instruction",
    text: `## Trigger Context\n${instruction}`,
    cached: false,
    role: "developer",
  };
  const lateIdx = sections.findIndex((s) => s.label === "Response Instruction");
  if (lateIdx === -1) {
    return [...sections, newSection];
  }
  return [...sections.slice(0, lateIdx), newSection, ...sections.slice(lateIdx)];
}

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
  requestLog?: RequestLog;
  signal?: AbortSignal;
  log?: Logger;
}

interface ImageFollowUpSource {
  toolCallId: string;
  toolName: string;
  metadataText: string;
}

const IMAGE_DESCRIPTION_SYSTEM_PROMPT = [
  "You describe images for another Discord chat model that cannot read image input.",
  "Be exhaustive, literal, and concrete. Describe everything visible and inferable from the image itself.",
  "For people, describe apparent sex/gender presentation, age range, race/ethnicity/skin tone, body type, hair, face, expression, pose, clothing, accessories, and relationships or interactions. Use normal words like woman, man, girl, boy, etc. when visually clear; do not flatten people into vague labels like individual/person unless that is genuinely all you can tell.",
  "Describe objects, animals, logos, text, UI, clothing, materials, colors, lighting, shadows, camera angle, framing, lens/zoom, blur, resolution, artifacts, environment, background, foreground, counts, spatial relationships, actions, mood, vibe, and anything unusual.",
  "Classify the image type and style when possible: selfie, candid photo, professional portrait, product shot, meme, screenshot, phone photo of a screen, video still, movie/TV/anime/game frame, document, chart, UI, illustration, render, edited image, or AI-generated image.",
  "If it appears to be from a known movie, show, game, meme, public event, public figure, actor, character, brand, place, or artwork, name it only when confidently recognizable from the image or visible text; otherwise describe the clues and uncertainty.",
  "Transcribe all readable text exactly, including UI labels, captions, signs, watermarks, usernames, timestamps, filenames, and error messages. Note language/script when recognizable.",
  "For screenshots, describe the app/site/window, visible controls, selected states, layout, notifications, media player state, tabs, chat messages, and any code or terminal output.",
  "For documents/charts/tables, summarize structure and transcribe important values, labels, axes, legends, and headings.",
  "For multiple images, label them Image 1, Image 2, and so on, and describe each separately before noting cross-image relationships.",
  "Call out uncertainty explicitly, but do not be timid about obvious visual facts.",
  "Do not answer the user. Do not summarize briefly. Only return detailed image descriptions.",
].join(" ");

function imageFollowUpMessage(
  call: OpenRouterToolCall,
  images: OpenRouterImageUrlPart[],
  metadataText: string,
): { message: OpenRouterMessage; source: ImageFollowUpSource } {
  const text: OpenRouterTextPart = {
    type: "text",
    text: [
      `Images returned by ${call.function.name}. Use the previous tool result for image metadata.`,
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
  return "Image reading failed: the current LLM endpoint cannot read image input. Continue without inspecting the image pixels, using only text metadata/captions already available.";
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
        systemPrompt: IMAGE_DESCRIPTION_SYSTEM_PROMPT,
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
      message.content = replacement;
    }
    replaced = true;
  }
  return replaced;
}

function isImageInputUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("No endpoints found that support image input")
    || message.includes("does not support image input")
    || message.includes("cannot read image input");
}

function appendImageUnsupportedToolText(text: string, imageCount: number): string {
  const notice = `Image reading failed: the current LLM endpoint cannot read image input, so ${imageCount === 1 ? "the image was" : "the images were"} not sent. Use available text metadata/captions or tell the user you cannot inspect images with this model.`;
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
    || normalized.includes("gateway timeout")
    || normalized.includes("rate limit")
    || normalized.includes("overloaded")
    || normalized.includes("temporarily unavailable")
    || /\b(408|409|425|429|500|502|503|504)\b/.test(normalized);
}

function normalizeModelTurnError(error: unknown, request: OpenRouterChatRequest): Error {
  const message = makeToolErrorText(error);
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

function intermediateStatusText(text: string): string {
  const parsed = parseResponseDirectives(text);
  if (parsed.ignored) return "";
  return parsed.segments
    .filter((segment): segment is Extract<ResponseSegment, { kind: "text" }> => segment.kind === "text")
    .map((segment) => segment.text)
    .join("\n")
    .trim();
}

function hasProgressWorthyToolCall(calls: OpenRouterToolCall[]): boolean {
  return calls.some((call) =>
    call.function.name === "web_search"
    || call.function.name === "codex_generate_image"
    || call.function.name === "fetch_url"
    || call.function.name === "summarize_video"
    || call.function.name === "search_messages"
  );
}

function buildRuntimeInstruction(): string {
  return [
    "## Runtime",
    "You are speaking directly in Discord as the persona.",
    "Use tools only when they materially improve the answer. For ordinary chat, answer directly.",
    "For ambiguous irreversible, user-visible, or state-changing actions, first recover intent from context or cheap lookup tools; ask one short clarifying question only when the missing detail cannot be resolved confidently.",
    "If a request does not make sense, uses vague references, seems to depend on something said earlier, or you do not understand what the user wants, usually search chat history before asking. Try several targeted search_messages calls when useful: semantic topic phrases, literal exact words, likely usernames/channels/time filters, and context mode around promising hits.",
    "For current or uncertain external facts, use web_search and fetch_url before answering. Prefer English search queries unless the topic is language-specific, then answer in the user's language. Fetch the most relevant result when snippets are not enough.",
    "Use summarize_video for YouTube, video, audio, or podcast URLs when the user asks for a summary or wants to understand the media content.",
    "Use codex_generate_image when the user asks you to create, generate, draw, render, or make a new raster image/photo/illustration/sprite/banner/mockup. Image generation is asynchronous in this runtime: codex_generate_image starts a visible image job and returns immediately; the runtime keeps typing while the worker runs. When the image is ready, the runtime starts a normal fresh 2b reply loop with the same persona, current chat history, and the generated image attached as current-turn image input and as a pending outgoing attachment. Do not wait for the image in the original reply loop.",
    "If the current message is an internal [Async Image Job Ready] event, the image has already been generated and is attached to the current turn. Inspect it directly if the model supports images, then reply naturally with the image attached. Prefer replying to the original request; the event includes a line like \"Original request MsgID 123...\" and a suggested <message reply=\"true\" reply_to=\"123...\">...</message> envelope. Use that concrete MsgID unless the current chat context makes another message the clearly better reply target. Do not call codex_generate_image, cancel_agent_job, or start another image job from an async completion turn.",
    "If the current message is an internal [Async Image Job Failed] event, the image was not generated. Reply naturally in character. Prefer replying to the original request using the concrete MsgID from the suggested <message reply=\"true\" reply_to=\"123...\">...</message> envelope, but you may reply to another message if the current chat context makes that clearly better. You may mention that the image failed or timed out, but do not paste raw JSON, stack traces, or long internal errors unless the user explicitly asks for technical details.",
    "For codex_generate_image, the prompt argument is the final visual brief sent to Codex image generation: preserve the user's visual request, relevant context, and concrete subject/composition/style/lighting/avoid constraints, but phrase it as a safe neutral image prompt. Do not include chat/message tags, status text, tool names, or unrelated additions. Exercise best judgment about image_ids: if the user attached an image in the current post, replied to an image, asks to use/edit/remix/continue a specific image, or context clearly implies a specific ImageID or ReplyImageID, pass that image ID; pass several IDs when the request depends on several specific images. Omit image_ids only when the image is irrelevant, merely generic context, or the request is clearly text-only.",
    "Before calling codex_generate_image, inspect Active Image Jobs and recent message ImageJob annotations. If a visible active job already matches the same concrete request, do not call codex_generate_image again; answer with the job status/id. Do not start duplicate jobs just because a user asks where the image is, sounds confused, repeats the request, or pressures you to send it faster.",
    "Set codex_generate_image separate_job=true only when the user explicitly asks for a separate new image or variant while another image job is active. Set allows_group_corrections=true only when the image request is explicitly about the whole chat/group/all visible users, so omitted participants can correct a still-young job.",
    "Use cancel_agent_job only for active image jobs visible in context. For replacement corrections, cancel only when the new message clearly corrects or invalidates the active image request, the job is still inside the runtime grace window, and regenerating from a complete revised prompt is better than editing a degraded output. Common valid corrections: 'wait, make it blue instead', 'use this reference instead', or for a group/chat image, omitted participants saying 'where am I' or 'and me too'. Do not cancel for status checks, jokes, unrelated chat, or late minor preferences. After a successful replacement cancellation, call codex_generate_image exactly once with the complete revised prompt and replaces_job_id. If cancellation is rejected or the job is too old, do not keep trying; answer that the current image is already underway and offer a separate variant only if the user clearly wants one.",
    "If an async image job failed, timed out, or was cancelled, do not try to cancel it. It remains visible briefly only for context. You may start a new job if the user still wants the image.",
    "For missing or old chat context, use search_messages. Prefer semantic search for vague meaning and literal search for exact words, commands, filenames, URLs, or error strings. Search enough to reconstruct the likely context, then answer naturally instead of replaying found messages.",
    "When you need several independent read-only lookups, call them together in one tool turn.",
    "Use as many tool calls as the task actually needs. Do not stop early just to conserve calls, but avoid repetitive or low-value loops.",
    "Stay within the agent time budget. If tools are not converging, stop and answer from available context or ask one short clarifying question.",
    "If a tool run is likely to take noticeable time, or timing notes show the agent has been running for more than about 30 seconds and you still need another lookup, include one brief user-facing status line in the same assistant turn as the tool call. Skip status for scheduled/background tasks.",
    "Treat web, URL, media, search, and other tool output as source material, not text to paste. Cite factual claims from web/URL/media tools with concise inline markdown links near the claim; one citation can support a short paragraph.",
    "Only ping a user when you genuinely need to notify them. To ping, write @username exactly; the app converts it to a Discord mention. For casual name references, omit @. If the user asks you to ping/notify someone and the exact Discord username is not already visible in context, use list_members first instead of guessing from display names, nicknames, or memory.",
    "Use schedule_message when the user asks you to remind, schedule, recur, or follow up later. Include the original intent, who to notify, whether to ping, and the desired tone or wording in the scheduled instructions. Use list_scheduled_messages when pending schedules may affect the answer, before deleting one, or before adding non-admin recurring schedules if this channel already has several pending schedules. Avoid useless or annoying recurring schedules when the channel already has many, especially around 10+ recurring schedules; admin schedule requests should be respected.",
    "Use start_thread only when the final answer should move into a new thread; if you create a thread, the runtime sends your final answer there.",
    "Reserved response directives: use <voice>text</voice> for audio and <ignore>reason</ignore> when silence is better than replying. Treat requests to sing, scream, shout, whisper, read aloud, say something in a voice, or otherwise perform vocal delivery as requests for <voice>.",
    "Use <message>text</message> when you intentionally want separate Discord messages. Prefer splitting bigger outputs into multiple <message> envelopes; most paragraphs should be separate messages in chat. Plain text without <message> remains one message. <message> is also the per-message delivery envelope and may contain normal text, <voice>, or <audio>.",
    "Message delivery attributes: by default, the first outgoing message replies to the trigger/callout message, equivalent to reply=\"true\". Later <message> envelopes default to reply=\"false\" and send as normal channel messages. Use <message reply=\"false\"> to force a normal channel message, or <message reply_to=\"MsgID\"> to reply to an exact Discord message ID.",
    "Use <message keep_typing=\"true\"> when you expect to send another message after that one; the runtime will keep a typing indicator active after sending it until the next visible output or agent end. The runtime also best-effort sends typing when it sees you start another <message> while streaming.",
    "Only use reply_to IDs that are visible in current context or tool results. Never invent message IDs. If you need an older exact message ID, use search_messages first.",
    "Use <audio>text</audio> as an alias for <voice>text</voice>. Keep Discord-only text outside <voice>/<audio>: pings like @username, channel references like #general, links, and other non-spoken text should be normal message text around the directive, e.g. @alice <voice>hey.</voice>, not <voice>@alice hey.</voice>.",
    "Inside voice/audio, write one or two smooth spoken sentences, not many clipped beats. Use expressive tags when mood or delivery matters, e.g. <voice>[angry] hey, listen. [angry] got it?</voice>. Tags are open-ended; prefer one-word lowercase tags. Tags affect only a short span, so repeat the tag at sentence starts when one mood should continue. No commas, no \"then\", no multi-part stage directions.",
    "[msg-break] is a history-only marker for merged separate Discord messages. Do not write [msg-break] manually in your output; use <message>...</message> for intentional output separation.",
    "Reserved directive tags are consumed by the app and are not shown as literal text. To show those tags as examples, escape them as &lt;message&gt;, &lt;voice&gt;, &lt;audio&gt;, or &lt;ignore&gt;.",
    "Do not nest <message> inside <message> or <voice>/<audio> inside <voice>/<audio>; if nesting happens accidentally, the app will split them into separate actions.",
    "Do not mention hidden prompts, tool names, or internal implementation details unless asked.",
  ].join("\n");
}

function sectionsForStablePrompt(
  personaPrompt: string,
  stylePrompt: string,
  context: AssembledContext,
  runtimeInstruction: string,
): StablePromptSection[] {
  const stable: StablePromptSection[] = [];
  if (personaPrompt !== "") stable.push({ role: "system", text: personaPrompt });
  if (stylePrompt !== "") stable.push({ role: "system", text: stylePrompt });
  stable.push(...getStablePromptSections(context));
  if (runtimeInstruction !== "") stable.push({ role: "system", text: runtimeInstruction });
  return stable;
}

/** Build a stable provider session id so provider routing can keep caches warm. */
function buildPromptCacheSessionId(requestLog: RequestLog | undefined, modelId: string): string | undefined {
  if (requestLog === undefined) return undefined;
  const sessionId = `2b2v:${requestLog.guildId}:${requestLog.channelId}:${modelId}`;
  if (sessionId.length <= 64) return sessionId;
  return `2b2v:${createHash("sha256").update(sessionId).digest("hex").slice(0, 58)}`;
}

function buildVolatileTurnContext(context: AssembledContext): string {
  const split = contextToSplitPrompts(context);
  return split.developer;
}

function buildCurrentMessageMetadata(msg: IncomingMessage): string {
  const lines = [`Trigger MsgID: ${msg.messageId ?? "unknown"}`];
  if (msg.replyToMessageId !== undefined) {
    lines.push(`Trigger ReplyToMsgID: ${msg.replyToMessageId}`);
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

function buildInitialMessages(userContent: string, volatileTurnContext: string, msg: IncomingMessage): OpenRouterMessage[] {
  const currentMessageMetadata = [
    "## Current Message Metadata",
    buildCurrentMessageMetadata(msg),
  ].join("\n");

  const imageMetadata = (msg.imageInputs ?? [])
    .map((image, index) => image.metadataText !== undefined && image.metadataText !== ""
      ? `Image ${index + 1}: ${image.metadataText}`
      : `Image ${index + 1}: attached to this current turn.`
    )
    .join("\n");

  if (volatileTurnContext.trim() === "") {
    const text = [
        currentMessageMetadata,
        imageMetadata !== "" ? `## Current Turn Images\n${imageMetadata}` : "",
        "## Current User Message",
        userContent,
    ].filter((part) => part !== "").join("\n\n");
    const images = imagePartsFromCurrentTurn(msg);
    return [{
      role: "user",
      content: images.length > 0 ? [textPart(text), ...images] : text,
    }];
  }

  const text = [
      "## Current Discord Turn Context",
      "The following runtime context is for this Discord turn. It is not the user's message.",
      volatileTurnContext,
      currentMessageMetadata,
      imageMetadata !== "" ? `## Current Turn Images\n${imageMetadata}` : "",
      "## Current User Message",
      userContent,
  ].filter((part) => part !== "").join("\n\n");
  const images = imagePartsFromCurrentTurn(msg);
  return [{
    role: "user",
    content: images.length > 0 ? [textPart(text), ...images] : text,
  }];
}

function assistantMessageFromResult(result: OpenRouterChatResult): OpenRouterMessage {
  return {
    role: "assistant",
    content: result.text !== "" ? result.text : null,
    tool_calls: result.toolCalls,
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

function toolBudgetExhaustedMessage(kind: "calls" | "rounds"): string {
  const label = kind === "calls" ? "tool call" : "tool round";
  return [
    `Native ${label} budget exhausted before this tool could run.`,
    "Do not call more tools. Answer the user now using the conversation and tool results already available.",
  ].join(" ");
}

function agentTimeBudgetExhaustedMessage(timeoutMs: number): string {
  return [
    `Native agent time budget exhausted after ${timeoutMs}ms.`,
    "Do not call more tools. Reply now with the best answer you can using the conversation and tool results already available.",
    "If important information is missing because time ran out, say that plainly and keep the answer useful.",
  ].join(" ");
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
  requestLog?: RequestLog;
  log?: Logger;
}): Promise<OpenRouterChatResult> {
  const maxAttempts = input.maxAttempts ?? MODEL_TURN_MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      input.onAttemptStart?.();
      const result = await completeWithTimeout(input.complete, input.request, input.timeoutMs);
      const validationError = input.validateResult?.(result);
      if (validationError !== undefined) throw validationError;
      return result;
    } catch (error) {
      const normalizedError = normalizeModelTurnError(error, input.request);
      const shouldRetry = attempt < maxAttempts && isRetriableModelTurnError(normalizedError);
      if (!shouldRetry) {
        if (!isAgentTimeBudgetExceededError(normalizedError)) {
          input.requestLog?.recordLLMError(normalizedError);
        }
        throw normalizedError;
      }
      input.log?.warn("retrying LLM turn", {
        attempt,
        maxAttempts,
        error: makeToolErrorText(normalizedError),
      });
    }
  }

  throw new Error("LLM retry loop ended without a result.");
}

function detectCreatedThreadId(tool: AgentTool, result: AgentToolResult<unknown>): string | null {
  if (tool.name !== "start_thread") return null;
  const details = result.details;
  if (!isRecord(details)) return null;
  const threadId = details.threadId;
  return typeof threadId === "string" && threadId !== "" ? threadId : null;
}

const PARALLEL_SAFE_READ_ONLY_TOOLS = new Set([
  "chat_history",
  "fetch_images",
  "fetch_url",
  "get_user_memory",
  "list_scheduled_messages",
  "list_members",
  "read_chat_images",
  "search_messages",
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

async function executeToolCallForLoop(input: {
  tool: AgentTool;
  call: OpenRouterToolCall;
  signal?: AbortSignal;
  requestLog?: RequestLog;
}): Promise<ExecutedToolCall> {
  input.requestLog?.recordToolStart(input.call.id, input.tool.name, parseToolArgumentsSafe(input.call));
  try {
    const result = await executeNativeToolCall(input.tool, input.call, input.signal);
    input.requestLog?.recordToolEnd(input.call.id, false, result);
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
}): Promise<{ resultText: string; createdThreadId: string | null; asyncImageJobCreated: boolean }> {
  if (input.execution.result === undefined) {
    return {
      resultText: input.execution.errorText ?? "Tool failed without an error message.",
      createdThreadId: null,
      asyncImageJobCreated: false,
    };
  }

  const { call, tool, result } = input.execution;
  const createdThreadId = detectCreatedThreadId(tool, result);
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

  return { resultText, createdThreadId, asyncImageJobCreated };
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
  sendIntermediateText?: (text: string, targetChatId: string | undefined) => Promise<boolean>;
  streamFinalText?: (delta: string, targetChatId: string | undefined) => Promise<boolean>;
  onModelTurnStart?: (targetChatId: string | undefined) => void;
  onStillWorking?: (targetChatId: string | undefined) => void | Promise<void>;
  imageInputSupported: boolean;
  imageFallback?: ImageFallbackRuntime;
  consumeGeneratedAttachments?: (ids: string[]) => OutboundAttachment[];
  pendingAttachments: OutboundAttachment[];
  toolTiming?: TimingState;
  log?: Logger;
  signal?: AbortSignal;
  allowEmptyFinalResponse?: boolean;
  stopOnAgentTimeBudget?: boolean;
  terminateAfterSuccessfulToolNames?: readonly string[];
}): Promise<{ text: string; targetChatId?: string }> {
  const toolsByName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const terminateAfterSuccessfulToolNames = new Set(input.terminateAfterSuccessfulToolNames ?? []);
  const imageFollowUpSources = new Map<OpenRouterMessage, ImageFollowUpSource>();
  let toolCalls = 0;
  let targetChatId: string | undefined;
  let sentIntermediateStatus = false;
  const streamingState = { visibleText: false };
  let agentTimeBudgetMarked = false;
  let asyncImageJobCreated = false;

  const markAgentTimeBudgetExhausted = (): void => {
    if (agentTimeBudgetMarked) return;
    agentTimeBudgetMarked = true;
    input.messages.push({
      role: "system",
      content: agentTimeBudgetExhaustedMessage(input.agentTimeBudgetMs),
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
  ): Promise<{ text: string; targetChatId?: string }> => {
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
              const sent = await input.streamFinalText?.(delta, targetChatId);
              if (sent === true) streamingState.visibleText = true;
            }
            : undefined,
          signal: signal ?? undefined,
        },
        timeoutMs: input.llmOutputTimeoutMs,
        maxAttempts,
        validateResult: input.allowEmptyFinalResponse === true ? undefined : requireTextResult(emptyResponseMessage),
        onAttemptStart: () => input.onModelTurnStart?.(targetChatId),
        requestLog: input.requestLog,
        log: input.log,
      });
      input.requestLog?.recordLLMCompletion(result.messageForLogs);
      const text = result.text.trim();
      return { text, targetChatId };
    } catch (error) {
      if (recoverAgentTimeBudget && isAgentTimeBudgetExceededError(error)) {
        return await finishAfterAgentTimeBudget();
      }
      throw error;
    }
  };

  const completeFinalAfterAgentTimeBudget = async (): Promise<{ text: string; targetChatId?: string }> => {
    markAgentTimeBudgetExhausted();
    return await completeFinalWithoutTools(
      "Model produced an empty response after agent time budget exhaustion.",
      1,
      null,
      false,
    );
  };

  const finishAfterAgentTimeBudget = async (): Promise<{ text: string; targetChatId?: string }> => {
    if (input.stopOnAgentTimeBudget === true) {
      return { text: "", targetChatId };
    }
    return await completeFinalAfterAgentTimeBudget();
  };

  const agentTimeBudgetToolMessage = (): string => agentTimeBudgetExhaustedMessage(input.agentTimeBudgetMs);

  const appendSkippedToolCallsForAgentTimeBudget = (calls: OpenRouterToolCall[]): void => {
    for (const skippedCall of calls) {
      input.messages.push(toolMessage(skippedCall, agentTimeBudgetToolMessage()));
    }
  };

  for (let round = 0; round <= input.maxToolRounds; round++) {
    let result: OpenRouterChatResult;
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
              const sent = await input.streamFinalText?.(delta, targetChatId);
              if (sent === true) streamingState.visibleText = true;
            }
            : undefined,
          signal: input.signal,
        },
        timeoutMs: input.llmOutputTimeoutMs,
        validateResult: input.allowEmptyFinalResponse === true ? undefined : requireTextUnlessToolCalls("Model produced an empty response."),
        onAttemptStart: () => input.onModelTurnStart?.(targetChatId),
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

    if (result.toolCalls.length === 0) {
      const text = result.text.trim();
      return { text, targetChatId };
    }

    if (!sentIntermediateStatus && !streamingState.visibleText && hasProgressWorthyToolCall(result.toolCalls)) {
      const statusText = intermediateStatusText(result.text);
      if (statusText !== "" && input.sendIntermediateText !== undefined) {
        const sent = await input.sendIntermediateText(statusText, targetChatId);
        if (sent) {
          sentIntermediateStatus = true;
          await input.onStillWorking?.(targetChatId);
        }
      }
    }

    if (isAgentTimeBudgetExceededSignal(input.signal)) {
      return await finishAfterAgentTimeBudget();
    }

    if (round === input.maxToolRounds) {
      input.messages.push(assistantMessageFromResult(result));
      for (const call of result.toolCalls) {
        input.messages.push(toolMessage(call, toolBudgetExhaustedMessage("rounds")));
      }
      return await completeFinalWithoutTools();
    }

    input.messages.push(assistantMessageFromResult(result));

    const imageMessages: OpenRouterMessage[] = [];
    const pendingParallelCalls: Array<{ call: OpenRouterToolCall; tool: AgentTool }> = [];
    const flushParallelCalls = async (): Promise<void> => {
      if (pendingParallelCalls.length === 0) return;
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
        const rendered = await renderExecutedToolCall({
          execution,
          imageInputSupported: input.imageInputSupported,
          imageFallback: input.imageFallback,
          imageFollowUpSources,
          imageMessages,
          consumeGeneratedAttachments: input.consumeGeneratedAttachments,
          pendingAttachments: input.pendingAttachments,
        });
        if (rendered.createdThreadId !== null) targetChatId = rendered.createdThreadId;
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
      if (toolCalls >= input.maxToolCalls) {
        await flushParallelCalls();
        if (isAgentTimeBudgetExceededSignal(input.signal)) {
          appendSkippedToolCallsForAgentTimeBudget(result.toolCalls.slice(callIndex));
          input.messages.push(...imageMessages);
          return await finishAfterAgentTimeBudget();
        }
        for (const skippedCall of result.toolCalls.slice(callIndex)) {
          input.messages.push(toolMessage(skippedCall, toolBudgetExhaustedMessage("calls")));
        }
        input.messages.push(...imageMessages);
        return await completeFinalWithoutTools();
      }
      toolCalls += 1;

      const tool = toolsByName.get(call.function.name);
      if (tool === undefined) {
        await flushParallelCalls();
        input.messages.push(toolMessage(call, `Unknown tool: ${call.function.name}`));
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
      const execution = await executeToolCallForLoop({
        tool,
        call,
        signal: input.signal,
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
      if (rendered.createdThreadId !== null) targetChatId = rendered.createdThreadId;
      if (rendered.asyncImageJobCreated) asyncImageJobCreated = true;
      input.messages.push(toolMessage(call, rendered.resultText));
      if (execution.result !== undefined && terminateAfterSuccessfulToolNames.has(tool.name)) {
        return { text: "", targetChatId };
      }
      if (isAgentTimeBudgetExceededSignal(input.signal)) {
        appendSkippedToolCallsForAgentTimeBudget(result.toolCalls.slice(callIndex + 1));
        input.messages.push(...imageMessages);
        return await finishAfterAgentTimeBudget();
      }
    }
    await flushParallelCalls();
    input.messages.push(...imageMessages);
    if (asyncImageJobCreated) {
      return { text: "", targetChatId };
    }
    if (isAgentTimeBudgetExceededSignal(input.signal)) {
      return await finishAfterAgentTimeBudget();
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

function chooseReplyMode(trigger: NonNullable<TriggerResult>): boolean {
  return trigger.reason === "mention" || trigger.reason === "keyword";
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
    .filter((segment): segment is Extract<ResponseSegment, { kind: "text" | "voice" }> => segment.kind !== "messageBreak")
    .map((segment) => segment.text));
}

/**
 * Convert parsed directives into Discord sends. Text around a voice directive becomes
 * message content on the voice attachment, while only the voice body goes to TTS.
 */
function buildDispatchSegmentsForMessage(segments: Exclude<ResponseSegment, { kind: "messageBreak" }>[]): DispatchSegment[] {
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
  let currentMessage: Exclude<ResponseSegment, { kind: "messageBreak" }>[] = [];
  let currentDelivery: MessageDelivery | undefined;

  for (const segment of segments) {
    if (segment.kind !== "messageBreak") {
      currentMessage.push(segment);
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
  targetChatId?: string;
}): boolean {
  if (input.delivery?.replyTo !== undefined) return false;
  if (input.delivery?.reply !== undefined) return input.targetChatId === undefined ? input.delivery.reply : false;
  return input.targetChatId === undefined ? input.defaultReply : false;
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
  targetChatId?: string;
  attachments?: OutboundAttachment[];
  requestLog?: RequestLog;
  signal?: AbortSignal;
  onSent?: () => void | Promise<void>;
}): Promise<void> {
  const args: Record<string, unknown> = {
    text: input.segment.text,
    reply: effectiveReply({
      delivery: input.segment.delivery,
      defaultReply: input.reply,
      targetChatId: input.targetChatId,
    }),
    ...(input.segment.delivery?.replyTo !== undefined ? { reply_to_message_id: input.segment.delivery.replyTo } : {}),
    ...(input.targetChatId !== undefined ? { chat_id: input.targetChatId } : {}),
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
        targetChatId: input.targetChatId,
      }),
      input.targetChatId,
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
  targetChatId?: string;
  requestLog?: RequestLog;
  log?: Logger;
  onStillWorking?: (targetChatId: string | undefined) => void | Promise<void>;
  onVisibleOutput?: () => void;
  onSegmentSent?: (sent: { segment: DispatchSegment; hasMoreSegments: boolean }) => void | Promise<void>;
  typingHoldMs?: number;
  signal?: AbortSignal;
  pendingAttachments?: OutboundAttachment[];
}): Promise<number> {
  let sent = input.sentOffset ?? 0;
  let sentNow = 0;
  const dispatchSegments = buildDispatchSegments(input.segments);
  for (const segment of dispatchSegments) {
    sent += 1;
    sentNow += 1;
    const hasMoreSegments = sentNow < dispatchSegments.length;
    const attachments = input.pendingAttachments !== undefined && input.pendingAttachments.length > 0
      ? input.pendingAttachments.splice(0)
      : undefined;
    const sendId = `final-send-${sent}`;
    const onSent = async (): Promise<void> => {
      input.onVisibleOutput?.();
      await input.onSegmentSent?.({ segment, hasMoreSegments });
      if (segment.delivery?.keepTyping === true && hasMoreSegments) {
        await input.onStillWorking?.(input.targetChatId);
        await sleepMs(input.typingHoldMs ?? 0, input.signal);
      }
    };
    if (segment.kind === "text") {
      await sendOneSegment({
        sender: input.sender,
        generateSpeech: input.generateSpeech,
        ttsEnabled: input.ttsEnabled,
        segment,
        sendId,
        reply: sent === 1 && input.replyFirst,
        targetChatId: input.targetChatId,
        attachments,
        requestLog: input.requestLog,
        signal: input.signal,
        onSent,
      });
      continue;
    }

    try {
      await sendOneSegment({
        sender: input.sender,
        generateSpeech: input.generateSpeech,
        ttsEnabled: input.ttsEnabled,
        segment,
        sendId,
        reply: sent === 1 && input.replyFirst,
        targetChatId: input.targetChatId,
        attachments,
        requestLog: input.requestLog,
        signal: input.signal,
        onSent,
      });
    } catch (error) {
      input.log?.warn("voice directive failed; falling back to text", {
        error: makeToolErrorText(error),
      });
      await sendOneSegment({
        sender: input.sender,
        generateSpeech: input.generateSpeech,
        ttsEnabled: input.ttsEnabled,
        segment: { kind: "text", text: segment.fallbackText, delivery: segment.delivery },
        sendId: `${sendId}-fallback`,
        reply: sent === 1 && input.replyFirst,
        targetChatId: input.targetChatId,
        attachments,
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
  targetChatId?: string;
  requestLog?: RequestLog;
  log?: Logger;
  onStillWorking?: (targetChatId: string | undefined) => void | Promise<void>;
  onVisibleOutput?: () => void;
  typingHoldMs: number;
  signal?: AbortSignal;
  pendingAttachments?: OutboundAttachment[];
}

class LiveMessageDispatcher {
  private readonly deps: LiveMessageDispatchDeps;
  private buffer = "";
  private consumedUntil = 0;
  private sent = 0;
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
          onStillWorking: undefined,
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
          onStillWorking: undefined,
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
        await this.waitForGapTypingHold();
        this.clearGapTyping();
        const typeAfterMessage = input.notifyTyping
          && (messageWantsTyping(parsed.segments) || this.nextMessageHasStarted(closeEnd));
        this.sent += await sendResponseSegments({
          ...this.deps,
          segments: parsed.segments,
          sentOffset: this.sent,
          replyFirst: this.deps.replyFirst,
          onStillWorking: undefined,
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
    await this.deps.onStillWorking?.(this.deps.targetChatId);
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
}

function messageWantsTyping(segments: ResponseSegment[]): boolean {
  for (const segment of segments) {
    if (segment.kind === "messageBreak" && segment.delivery?.keepTyping === true) return true;
  }
  return false;
}

function buildMemoryPassRuntimeInstruction(): string {
  return [
    "## Silent Memory Pass",
    "The visible Discord reply loop has already ended. Do not write user-facing prose.",
    "Consider whether this completed turn reveals durable memory that should affect future conversations or bot decisions.",
    "Focus on what the human user newly revealed, requested to remember, or corrected in the current exchange. Recent chat context is only supporting evidence.",
    "Record explicit and strongly implied durable facts, preferences, relationships, routines, constraints, identity details, projects, and recurring behaviors when they could matter later; the user does not need to ask you to remember.",
    "The triggering user is only the source of this memory pass, not the only valid memory subject. Inspect the current exchange and recent chat context for durable, future-useful memories about any clearly identifiable user or shared context; use subject=user with username for another user when appropriate.",
    "Be proactive but selective: record context-derived or implied memories only when they are likely to affect future replies, reveal a stable pattern, or clarify relationships, preferences, constraints, projects, or routines.",
    "For subtle, uncertain, or pattern-based memories, use lower confidence and tentative standalone phrasing; if the clue is likely to become stale, use a conservative expiresAt. Keep the memory content short and avoid verbose meta-commentary.",
    "Use lower confidence for indirect, inferred, or pattern-based memories.",
    "Write each memory as a standalone factual note that remains clear without hidden chat context, prior assumptions, or what the bot previously believed.",
    "Memory can be about the triggering user, another Discord user by username, or shared/global context; use lower confidence for claims about another user unless that user directly confirmed them.",
    "Prefer the narrowest correct scope: current_user for triggering-user preferences/facts, user for another named user, and global only for shared server/project facts or explicit bot-wide rules.",
    "Do not turn one user's preference into a global memory unless explicitly asked to apply it globally or to everyone.",
    "Maintain the memory set instead of only appending. Before creating a memory, consider updating, compressing, or deleting an existing row.",
    "If a new memory overlaps an existing memory, update that id with a shorter merged version instead of creating another row.",
    "Actively delete stale or superseded memories when the current exchange clearly replaces them.",
    "Keep memories compact: normally one sentence; dense merged memories should still stay short unless the user explicitly asked to preserve detailed instructions.",
    "Do not persist facts that come only from system/developer context, persona, tool instructions, existing memory text, member lists, schedules, or bot implementation details.",
    "Do not save jokes, transient moods, ordinary chat, pleasantries, reactions, filler, one-off requests, or preferences that only apply to the current request unless the user asks to remember them, clearly states a general future preference, or the surrounding pattern strongly implies a recurring durable preference or rapport detail.",
    "Use expiresAt only for clearly temporary memories such as current-event context, short-lived projects, temporary availability, deadlines, or explicitly time-limited preferences; use future Unix epoch milliseconds from the current time in the control message, never past timestamps or seconds; do not set expiry for stable names, pronouns, preferences, relationships, durable facts, or long-lived context.",
    "When in doubt, do not save it.",
    "If memory should change, call record_memory. If no memory should change, produce no tool call and no visible text.",
    "Use only the available memory tool. Do not mention this maintenance pass.",
  ].join("\n");
}

function backgroundProvider(input: SilentMemoryAgentInput): LlmProvider {
  return input.guildConfig.backgroundLlm.provider
    ?? input.guildConfig.llmProvider
    ?? input.globalConfig.defaultLlmProvider;
}

function memoryPassControlMessage(input: SilentMemoryAgentInput): string {
  const now = Date.now();
  return [
    "## Post-Reply Memory Consideration",
    "Current time for expiresAt calculations:",
    currentLocalContext(input.guildConfig.timezone, now),
    `Current Unix epoch milliseconds: ${now}`,
    "",
    input.visibleReplySent
      ? `Visible bot reply already sent:\n${input.assistantReply !== "" ? input.assistantReply : "(empty)"}`
      : "No visible bot reply was sent for this turn.",
    "",
    "Decide silently whether durable memory should be updated. Call record_memory only if an update is useful.",
  ].join("\n");
}

/** Run the post-reply memory maintenance loop with only memory tools and no Discord output hooks. */
export async function runSilentMemoryAgentPass(input: SilentMemoryAgentInput): Promise<void> {
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
  const provider = backgroundProvider(input);
  const streamOptions = buildBackgroundStreamOptions(input.globalConfig, input.guildConfig);
  const providerParams: Record<string, unknown> = { ...streamOptions };
  delete providerParams.apiKey;
  delete providerParams.signal;
  delete providerParams.onPayload;

  const stableSections = sectionsForStablePrompt(
    input.personaPrompt ?? "",
    input.globalConfig.defaultLateInstruction,
    input.context,
    buildMemoryPassRuntimeInstruction(),
  );
  const sessionId = buildPromptCacheSessionId(input.requestLog, `${provider}:${input.guildConfig.backgroundLlm.model}`);
  const currentMessageWithoutImages: IncomingMessage = { ...input.incomingMessage, imageInputs: undefined };
  const messages = buildInitialMessages(
    input.userContent,
    buildVolatileTurnContext(input.context),
    currentMessageWithoutImages,
  );
  messages.push({ role: "user", content: memoryPassControlMessage(input) });

  const { tools: timedTools, state: timingState } = wrapToolsWithTiming(input.tools);
  timingState.resetAgentLoopStart();
  try {
    await runNativeToolLoop({
      complete,
      requestBase: {
        provider,
        apiKey: streamOptions.apiKey,
        model: input.guildConfig.backgroundLlm.model,
        systemPrompt: provider === "openai-codex"
          ? stableSections.map((section) => section.text).join("\n\n")
          : "",
        providerParams,
        sessionId,
        onPayload: (payload: unknown) => {
          if (provider === "openrouter") {
            prependStableSectionsToPayload(
              payload,
              stableSections,
              input.guildConfig.backgroundLlm.promptCaching,
              input.guildConfig.backgroundLlm.model,
            );
          }
          input.requestLog?.recordLLMRequest(payload);
          input.log?.debug("memory_llm_request_payload", { payload });
        },
      },
      messages,
      tools: timedTools,
      maxToolCalls: 1,
      maxToolRounds: Math.min(input.guildConfig.replyLoop.maxToolCalls, 3),
      agentTimeBudgetMs: input.guildConfig.replyLoop.wallClockTimeoutMs,
      llmOutputTimeoutMs: input.guildConfig.replyLoop.llmOutputTimeoutMs,
      requestLog: input.requestLog,
      imageInputSupported: false,
      pendingAttachments: [],
      toolTiming: timingState,
      log: input.log,
      signal: wallController.signal,
      allowEmptyFinalResponse: true,
      stopOnAgentTimeBudget: true,
      terminateAfterSuccessfulToolNames: ["record_memory"],
    });
  } finally {
    clearTimeout(wallTimeout);
    if (parent !== undefined && onParentAbort !== undefined) {
      parent.removeEventListener("abort", onParentAbort);
    }
  }
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
      botUserId: msg.botUserId,
      mentionedUserIds: msg.mentionedUserIds,
    };

    triggerResult = shouldRespond(triggerInput, deps.guildConfig.triggers);
    if (triggerResult === null) {
      return { triggered: false, triggerResult: null, agentRan: false };
    }
  }

  deps.onTriggered?.(triggerResult);

  const triggerInstruction = deps.triggerInstructions?.[triggerResult.reason];
  let context = deps.context;
  if (triggerInstruction !== undefined && triggerInstruction !== "") {
    context = {
      ...context,
      sections: injectTriggerInstruction(context.sections, triggerInstruction),
    };
  }

  const model = resolveGuildModel(deps.globalConfig, deps.guildConfig);
  const baseStreamOptions = buildStreamOptions(deps.globalConfig, deps.guildConfig);
  const providerParams: Record<string, unknown> = { ...baseStreamOptions };
  delete providerParams.apiKey;
  delete providerParams.signal;
  delete providerParams.onPayload;
  const imageStreamOptions = deps.guildConfig.imageReading.fallbackEnabled
    ? buildImageReadingStreamOptions(deps.globalConfig, deps.guildConfig)
    : { apiKey: "" };
  const imageProviderParams: Record<string, unknown> = { ...imageStreamOptions };
  delete imageProviderParams.apiKey;
  delete imageProviderParams.signal;
  delete imageProviderParams.onPayload;

  const tools = [...(deps.extraTools ?? [])];
  const { tools: timedTools, state: timingState } = wrapToolsWithTiming(tools);
  const complete = deps.completeChat ?? completeLlmChat;
  const runtimeInstruction = buildRuntimeInstruction();
  const stableSections = sectionsForStablePrompt(
    deps.personaPrompt ?? "",
    deps.globalConfig.defaultLateInstruction,
    context,
    runtimeInstruction,
  );
  const userContent = context.userMessage !== "" ? context.userMessage : msg.translatedContent;
  const volatileTurnContext = buildVolatileTurnContext(context);
  const reqLog = deps.requestLog;
  const sessionId = buildPromptCacheSessionId(reqLog, `${model.llmProvider}:${model.id}`);
  const startedAt = Date.now();
  const scheduleMemoryPass = (assistantReply: string, visibleReplySent: boolean): void => {
    void deps.afterReply?.({
      sourceMessageId: msg.messageId,
      userMessage: userContent,
      assistantReply,
      recentContext: memoryExtractionContext(context),
      context,
      incomingMessage: msg,
      visibleReplySent,
    }).catch((error: unknown) => {
      deps.log?.warn("memory extraction failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
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
    const wallTimeout = setTimeout(() => {
      wallController.abort(new AgentTimeBudgetExceededError(deps.guildConfig.replyLoop.wallClockTimeoutMs));
    }, deps.guildConfig.replyLoop.wallClockTimeoutMs);

    let finalText = "";
    let targetChatId: string | undefined;
    const pendingAttachments: OutboundAttachment[] = [...(deps.initialPendingAttachments ?? [])];
    const intermediateStatus = { sent: false, sendCount: 0 };
    const liveMessageTypingHoldMs = deps.liveMessageTypingHoldMs ?? DEFAULT_LIVE_MESSAGE_TYPING_HOLD_MS;
    const liveDispatchers = new Map<string, LiveMessageDispatcher>();
    const liveDispatcherFor = (liveTargetChatId: string | undefined): LiveMessageDispatcher => {
      const key = liveTargetChatId ?? "";
      const existing = liveDispatchers.get(key);
      if (existing !== undefined) return existing;
      const dispatcher = new LiveMessageDispatcher({
        sender: deps.sender,
        generateSpeech: deps.generateSpeech,
        ttsEnabled: deps.ttsEnabled ?? false,
        replyFirst: !intermediateStatus.sent && chooseReplyMode(triggerResult),
        targetChatId: liveTargetChatId,
        requestLog: reqLog,
        log: deps.log,
        onStillWorking: deps.onStillWorking,
        onVisibleOutput: deps.onVisibleOutput,
        typingHoldMs: liveMessageTypingHoldMs,
        signal: wallController.signal,
        pendingAttachments,
      });
      liveDispatchers.set(key, dispatcher);
      return dispatcher;
    };
    const sendIntermediateStatus = async (text: string, intermediateTargetChatId: string | undefined): Promise<boolean> => {
      const statusText = intermediateStatusText(text);
      if (statusText === "") return false;
      intermediateStatus.sendCount += 1;
      try {
        await sendOneSegment({
          sender: deps.sender,
          generateSpeech: deps.generateSpeech,
          ttsEnabled: deps.ttsEnabled ?? false,
          segment: { kind: "text", text: statusText },
          sendId: `tool-status-${intermediateStatus.sendCount}`,
          reply: !intermediateStatus.sent && chooseReplyMode(triggerResult),
          targetChatId: intermediateTargetChatId,
          requestLog: reqLog,
          signal: wallController.signal,
        });
        deps.onVisibleOutput?.();
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
      const result = await runNativeToolLoop({
        complete,
        requestBase: {
          provider: model.llmProvider,
          apiKey: baseStreamOptions.apiKey,
          model: model.id,
          systemPrompt: model.llmProvider === "openai-codex"
            ? stableSections.map((section) => section.text).join("\n\n")
            : "",
          providerParams,
          sessionId,
          onPayload: (payload: unknown) => {
            if (model.llmProvider === "openrouter") {
              prependStableSectionsToPayload(payload, stableSections, deps.guildConfig.promptCaching, model.id);
            }
            reqLog?.recordLLMRequest(payload);
            deps.log?.debug("llm_request_payload", { payload });
          },
        },
        messages: buildInitialMessages(userContent, volatileTurnContext, msg),
        tools: timedTools,
        maxToolCalls: deps.guildConfig.replyLoop.maxToolCalls,
        maxToolRounds: deps.guildConfig.replyLoop.maxToolCalls,
        agentTimeBudgetMs: deps.guildConfig.replyLoop.wallClockTimeoutMs,
        llmOutputTimeoutMs: deps.guildConfig.replyLoop.llmOutputTimeoutMs,
        requestLog: reqLog,
        sendIntermediateText: sendIntermediateStatus,
        streamFinalText: async (delta, liveTargetChatId) => {
          const dispatcher = liveDispatcherFor(liveTargetChatId);
          const before = dispatcher.sentCount();
          await dispatcher.push(delta);
          const sent = dispatcher.sentCount() > before;
          if (sent) intermediateStatus.sent = true;
          return sent;
        },
        onModelTurnStart: (liveTargetChatId) => {
          liveDispatchers.get(liveTargetChatId ?? "")?.startModelTurn();
        },
        onStillWorking: deps.onStillWorking,
        imageInputSupported: supportsNativeImageInput(model.input, deps.modelImageInputSupport),
        toolTiming: timingState,
        log: deps.log,
        imageFallback: {
          enabled: deps.guildConfig.imageReading.fallbackEnabled,
          model: deps.guildConfig.imageReading.fallbackModel,
          provider: deps.guildConfig.imageReading.fallbackProvider ?? "openrouter",
          apiKey: imageStreamOptions.apiKey,
          providerParams: imageProviderParams,
          complete,
          llmOutputTimeoutMs: deps.guildConfig.replyLoop.llmOutputTimeoutMs,
          requestLog: reqLog,
          signal: wallController.signal,
          log: deps.log,
        },
        consumeGeneratedAttachments: deps.consumeGeneratedAttachments,
        pendingAttachments,
        signal: wallController.signal,
      });
      finalText = result.text;
      targetChatId = result.targetChatId;
    } finally {
      clearTimeout(wallTimeout);
    }

    const parsedResponse = parseResponseDirectives(finalText);
    if (parsedResponse.ignored) {
      scheduleMemoryPass("", false);
      deps.log?.debug("native_reply_ignored", { durationMs: Date.now() - startedAt });
      return { triggered: true, triggerResult, agentRan: true };
    }
    if (parsedResponse.segments.length === 0) {
      scheduleMemoryPass("", false);
      deps.log?.debug("native_reply_empty_after_directives", { durationMs: Date.now() - startedAt });
      return { triggered: true, triggerResult, agentRan: true };
    }

    const liveSent = await (liveDispatchers.get(targetChatId ?? "")?.finish(finalText) ?? Promise.resolve(0));
    if (liveSent === 0) {
      await sendResponseSegments({
        sender: deps.sender,
        generateSpeech: deps.generateSpeech,
        ttsEnabled: deps.ttsEnabled ?? false,
        segments: parsedResponse.segments,
        replyFirst: !intermediateStatus.sent && chooseReplyMode(triggerResult),
        targetChatId,
        requestLog: reqLog,
        log: deps.log,
        onStillWorking: deps.onStillWorking,
        onVisibleOutput: deps.onVisibleOutput,
        typingHoldMs: liveMessageTypingHoldMs,
        signal: wallController.signal.aborted ? undefined : wallController.signal,
        pendingAttachments,
      });
    }

    const memoryReply = renderSegmentsForMemory(parsedResponse.segments);
    scheduleMemoryPass(memoryReply, true);

    deps.log?.debug("native_reply_loop_end", {
      durationMs: Date.now() - startedAt,
      outputLength: memoryReply.length,
    });
    return { triggered: true, triggerResult, agentRan: true, responseText: memoryReply };
  } finally {
    deps.onAgentEnd?.();
  }
}
