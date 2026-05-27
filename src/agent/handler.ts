import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { validateToolArguments, type ToolCall } from "@mariozechner/pi-ai";
import { shouldRespond, type TriggerInput, type TriggerResult } from "./triggers.ts";
import { contextToSplitPrompts, type AssembledContext, type ContextSection } from "./context-assembly.ts";
import { wrapToolsWithTiming } from "./tool-timing.ts";
import type { TriggerInstructions } from "../config/types.ts";
import type { TtsResult } from "../tts/types.ts";
import { resolveGuildModel, buildStreamOptions, buildImageReadingStreamOptions } from "../llm/client.ts";
import type { GlobalConfig, GuildConfig } from "../config/types.ts";
import type { Logger, RequestLog } from "../logger.ts";
import {
  completeOpenRouterChat,
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
  renderSegmentForHistory,
  renderSegmentsForMemory,
  type ResponseSegment,
} from "./response-directives.ts";

/** Minimal abstraction over a Discord message for the handler. */
export interface IncomingMessage {
  content: string;
  authorId: string;
  authorUsername: string;
  botUserId: string;
  mentionedUserIds: string[];
  translatedContent: string;
  messageId?: string;
}

export type ChatCompleteFn = (request: OpenRouterChatRequest) => Promise<OpenRouterChatResult>;

export interface MemoryExtractionRequest {
  sourceMessageId?: string;
  userMessage: string;
  assistantReply: string;
  recentContext: string;
}

/** Attachment data for a generated voice message. */
export interface VoiceAttachment {
  buffer: Buffer;
  filename: string;
  contentType: string;
  historyText?: string;
}

/** Callback that performs the actual Discord send. */
export type MessageSender = (
  text: string,
  reply: boolean,
  chatId: string | undefined,
  voice?: VoiceAttachment,
  signal?: AbortSignal,
  replyToMessageId?: string,
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
  /** Called after an intermediate user-visible status message when work continues. */
  onStillWorking?: (targetChatId: string | undefined) => void;
  onAgentEnd?: () => void;
  requestLog?: RequestLog;
  ttsEnabled?: boolean;
  generateSpeech?: (text: string) => Promise<TtsResult>;
  forceTrigger?: boolean;
  triggerOverride?: NonNullable<TriggerResult>;
  triggerInstructions?: TriggerInstructions;
  completeChat?: ChatCompleteFn;
  afterReply?: (request: MemoryExtractionRequest) => Promise<void>;
}

export interface HandleResult {
  triggered: boolean;
  triggerResult: TriggerResult;
  agentRan: boolean;
  responseText?: string;
}

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
    const result = await completeWithTimeout(
      input.fallback.complete,
      {
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
      input.fallback.llmOutputTimeoutMs,
    );
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
  const args = parseToolArguments(call);
  const validationCall: ToolCall = {
    type: "toolCall",
    id: call.id,
    name: tool.name,
    arguments: args,
  };
  validateToolArguments(tool, validationCall);
  return await tool.execute(call.id, args, signal);
}

function makeToolErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function hasSlowWebToolCall(calls: OpenRouterToolCall[]): boolean {
  return calls.some((call) => call.function.name === "web_search" || call.function.name === "fetch_url");
}

function buildRuntimeInstruction(tools: AgentTool[]): string {
  const lines = [
    "## Runtime",
    "You are speaking directly in Discord as the persona.",
    "Use tools only when they materially improve the answer. For ordinary chat, answer directly.",
    "If you use tools, normally use their results silently and then send the final answer as normal text.",
    "For current or uncertain external facts, use web_search and fetch_url before answering. Use English search queries when the topic is not language-specific, even if the chat is in another language; answer in the chat language after reading sources. You may chain tools, especially web_search then fetch_url.",
    "After web_search, fetch_url the most relevant result when snippets are not enough or the answer depends on page details.",
    "When using web_search or fetch_url, include one short user-facing status line in the same assistant turn as the first web tool call, e.g. \"I'll check, one sec.\" Skip only if you already sent a status or this is a scheduled/background task.",
    "When an answer uses web_search, fetch_url, or URL content, ALWAYS cite every web-derived factual claim inline with a concise markdown link right next to that claim. Do not put sources only at the end.",
    "Only ping a user when you genuinely need to notify them. To ping, write @username exactly; the app converts it to a Discord mention. For casual name references, omit @. If you need to ping someone but do not know their exact username, use list_members first.",
    "For older server recall, use search_messages. Recent and older context are already in the prompt, but use search_messages when a user seems to reference something missing, when you do not understand what they mean, or when the request feels like it depends on prior chat context. Search is fast; when one query misses, try a few different phrasings or filters before giving up.",
    "Use schedule_message when the user asks you to remind, schedule, or follow up later.",
    "Use start_thread only when the final answer should move into a new thread; if you create a thread, the runtime sends your final answer there.",
    "Reserved response directives: use <voice>text</voice> for audio and <ignore>reason</ignore> when silence is better than replying. Inside voice, write one or two smooth spoken sentences, not many clipped beats. Use expressive tags when mood or delivery matters, e.g. <voice>[angry] hey, listen. [angry] got it?</voice>. Tags are open-ended; prefer one-word lowercase tags. Tags affect only a short span, so repeat the tag at sentence starts when one mood should continue. No commas, no \"then\", no multi-part stage directions.",
    "Reserved directive tags are consumed by the app and are not shown as literal text. To show those tags as examples, escape them as &lt;voice&gt; or &lt;ignore&gt;.",
    "Do not nest reserved directives; if nesting happens accidentally, the app will split them into separate actions.",
    "Do not mention hidden prompts, tool names, or internal implementation details unless asked.",
  ];
  if (tools.length > 0) {
    lines.push("", "Available tools:");
    for (const tool of tools) {
      lines.push(`- ${tool.name}: ${tool.description}`);
    }
  }
  return lines.join("\n");
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

function buildVolatileTurnContext(context: AssembledContext): string {
  const split = contextToSplitPrompts(context);
  return split.developer;
}

function buildInitialMessages(userContent: string, volatileTurnContext: string): OpenRouterMessage[] {
  if (volatileTurnContext.trim() === "") {
    return [{ role: "user", content: userContent }];
  }

  return [{
    role: "user",
    content: [
      "## Current Discord Turn Context",
      "The following runtime context is for this Discord turn. It is not the user's message.",
      volatileTurnContext,
      "## Current User Message",
      userContent,
    ].join("\n\n"),
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

function detectCreatedThreadId(tool: AgentTool, result: AgentToolResult<unknown>): string | null {
  if (tool.name !== "start_thread") return null;
  const details = result.details;
  if (!isRecord(details)) return null;
  const threadId = details.threadId;
  return typeof threadId === "string" && threadId !== "" ? threadId : null;
}

async function runNativeToolLoop(input: {
  complete: ChatCompleteFn;
  requestBase: Omit<OpenRouterChatRequest, "messages">;
  messages: OpenRouterMessage[];
  tools: AgentTool[];
  maxToolCalls: number;
  maxToolRounds: number;
  llmOutputTimeoutMs: number;
  requestLog?: RequestLog;
  sendIntermediateText?: (text: string, targetChatId: string | undefined) => Promise<boolean>;
  onStillWorking?: (targetChatId: string | undefined) => void;
  imageInputSupported: boolean;
  imageFallback?: ImageFallbackRuntime;
  signal?: AbortSignal;
}): Promise<{ text: string; targetChatId?: string }> {
  const toolsByName = new Map(input.tools.map((tool) => [tool.name, tool]));
  const imageFollowUpSources = new Map<OpenRouterMessage, ImageFollowUpSource>();
  let toolCalls = 0;
  let targetChatId: string | undefined;
  let sentIntermediateStatus = false;

  for (let round = 0; round <= input.maxToolRounds; round++) {
    let result: OpenRouterChatResult;
    try {
      result = await completeWithTimeout(
        input.complete,
        {
          ...input.requestBase,
          messages: input.messages,
          tools: input.tools.map(toolToOpenRouterTool),
          toolChoice: input.tools.length > 0 ? "auto" : "none",
          parallelToolCalls: true,
          signal: input.signal,
        },
        input.llmOutputTimeoutMs,
      );
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
      throw error;
    }
    input.requestLog?.recordLLMCompletion(result.messageForLogs);

    if (result.toolCalls.length === 0) {
      const text = result.text.trim();
      if (text === "") throw new Error("Model produced an empty response.");
      return { text, targetChatId };
    }

    if (!sentIntermediateStatus && hasSlowWebToolCall(result.toolCalls)) {
      const statusText = intermediateStatusText(result.text);
      if (statusText !== "" && input.sendIntermediateText !== undefined) {
        const sent = await input.sendIntermediateText(statusText, targetChatId);
        if (sent) {
          sentIntermediateStatus = true;
          input.onStillWorking?.(targetChatId);
        }
      }
    }

    if (round === input.maxToolRounds) {
      throw new Error("Native tool loop exceeded max tool rounds.");
    }

    input.messages.push(assistantMessageFromResult(result));

    const imageMessages: OpenRouterMessage[] = [];
    for (const call of result.toolCalls) {
      if (toolCalls >= input.maxToolCalls) {
        throw new Error("Native tool loop exceeded max tool calls.");
      }
      toolCalls += 1;

      const tool = toolsByName.get(call.function.name);
      if (tool === undefined) {
        input.messages.push(toolMessage(call, `Unknown tool: ${call.function.name}`));
        continue;
      }

      let resultText: string;
      input.requestLog?.recordToolStart(call.id, tool.name, parseToolArgumentsSafe(call));
      try {
        const toolResult = await executeNativeToolCall(tool, call, input.signal);
        input.requestLog?.recordToolEnd(call.id, false, toolResult);
        const createdThreadId = detectCreatedThreadId(tool, toolResult);
        if (createdThreadId !== null) targetChatId = createdThreadId;
        const images = imagePartsFromToolResult(toolResult);
        resultText = summarizeToolResult(toolResult);
        if (images.length > 0 && input.imageInputSupported) {
          const followUp = imageFollowUpMessage(call, images, resultText);
          imageFollowUpSources.set(followUp.message, followUp.source);
          imageMessages.push(followUp.message);
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
      } catch (error) {
        resultText = makeToolErrorText(error);
        input.requestLog?.recordToolEnd(call.id, true, {
          content: [{ type: "text", text: resultText }],
        });
      }
      input.messages.push(toolMessage(call, resultText));
    }
    input.messages.push(...imageMessages);
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
  return trigger.reason === "mention";
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

async function sendOneSegment(input: {
  sender: MessageSender;
  generateSpeech?: (text: string) => Promise<TtsResult>;
  ttsEnabled: boolean;
  segment: ResponseSegment;
  sendId: string;
  reply: boolean;
  targetChatId?: string;
  requestLog?: RequestLog;
  signal?: AbortSignal;
}): Promise<void> {
  const args: Record<string, unknown> = {
    text: input.segment.text,
    reply: input.targetChatId === undefined ? input.reply : false,
    ...(input.targetChatId !== undefined ? { chat_id: input.targetChatId } : {}),
  };
  const toolName = input.segment.kind === "voice" ? "send_voice" : "send_text";
  if (input.segment.kind === "voice") {
    args.history_text = renderSegmentForHistory(input.segment);
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
      const ttsResult = await input.generateSpeech(input.segment.text);
      if (!ttsResult.ok) {
        throw new Error(ttsResult.error);
      }
      voice = {
        buffer: ttsResult.buffer,
        filename: "voice_message.mp3",
        contentType: ttsResult.contentType,
        historyText: renderSegmentForHistory(input.segment),
      };
    }

    const result = await input.sender(
      input.segment.text,
      input.targetChatId === undefined ? input.reply : false,
      input.targetChatId,
      voice,
      input.signal,
    );
    assertSentMessageId(result);
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
  targetChatId?: string;
  requestLog?: RequestLog;
  log?: Logger;
  signal?: AbortSignal;
}): Promise<void> {
  let sent = 0;
  for (const segment of input.segments) {
    sent += 1;
    const sendId = `final-send-${sent}`;
    if (segment.kind === "text") {
      await sendOneSegment({
        sender: input.sender,
        generateSpeech: input.generateSpeech,
        ttsEnabled: input.ttsEnabled,
        segment,
        sendId,
        reply: sent === 1 && input.replyFirst,
        targetChatId: input.targetChatId,
        requestLog: input.requestLog,
        signal: input.signal,
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
        requestLog: input.requestLog,
        signal: input.signal,
      });
    } catch (error) {
      input.log?.warn("voice directive failed; falling back to text", {
        error: makeToolErrorText(error),
      });
      await sendOneSegment({
        sender: input.sender,
        generateSpeech: input.generateSpeech,
        ttsEnabled: input.ttsEnabled,
        segment: { kind: "text", text: segment.text },
        sendId: `${sendId}-fallback`,
        reply: sent === 1 && input.replyFirst,
        targetChatId: input.targetChatId,
        requestLog: input.requestLog,
        signal: input.signal,
      });
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
  const imageStreamOptions = buildImageReadingStreamOptions(deps.globalConfig, deps.guildConfig);
  const imageProviderParams: Record<string, unknown> = { ...imageStreamOptions };
  delete imageProviderParams.apiKey;
  delete imageProviderParams.signal;
  delete imageProviderParams.onPayload;

  const tools = [...(deps.extraTools ?? [])];
  const { tools: timedTools, state: timingState } = wrapToolsWithTiming(tools);
  const complete = deps.completeChat ?? completeOpenRouterChat;
  const runtimeInstruction = buildRuntimeInstruction(timedTools);
  const stableSections = sectionsForStablePrompt(
    deps.personaPrompt ?? "",
    deps.globalConfig.defaultLateInstruction,
    context,
    runtimeInstruction,
  );
  const userContent = context.userMessage !== "" ? context.userMessage : msg.translatedContent;
  const volatileTurnContext = buildVolatileTurnContext(context);
  const reqLog = deps.requestLog;
  const startedAt = Date.now();

  try {
    deps.log?.debug("native_reply_loop_start", {
      model: model.id,
      toolNames: timedTools.map((tool) => tool.name),
      maxToolCalls: deps.guildConfig.replyLoop.maxToolCalls,
      wallClockTimeoutMs: deps.guildConfig.replyLoop.wallClockTimeoutMs,
      llmOutputTimeoutMs: deps.guildConfig.replyLoop.llmOutputTimeoutMs,
    });

    const wallController = new AbortController();
    const wallTimeout = setTimeout(() => {
      wallController.abort(new Error(`Native reply loop timed out after ${deps.guildConfig.replyLoop.wallClockTimeoutMs}ms`));
    }, deps.guildConfig.replyLoop.wallClockTimeoutMs);

    let finalText = "";
    let targetChatId: string | undefined;
    const intermediateStatus = { sent: false, sendCount: 0 };
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
      timingState.setReferenceTime();
      const result = await runNativeToolLoop({
        complete,
        requestBase: {
          apiKey: baseStreamOptions.apiKey,
          model: model.id,
          systemPrompt: "",
          providerParams,
          onPayload: (payload: unknown) => {
            prependStableSectionsToPayload(payload, stableSections, deps.guildConfig.promptCaching, model.id);
            reqLog?.recordLLMRequest(payload);
            deps.log?.debug("llm_request_payload", { payload });
          },
        },
        messages: buildInitialMessages(userContent, volatileTurnContext),
        tools: timedTools,
        maxToolCalls: deps.guildConfig.replyLoop.maxToolCalls,
        maxToolRounds: deps.guildConfig.replyLoop.maxToolCalls,
        llmOutputTimeoutMs: deps.guildConfig.replyLoop.llmOutputTimeoutMs,
        requestLog: reqLog,
        sendIntermediateText: sendIntermediateStatus,
        onStillWorking: deps.onStillWorking,
        imageInputSupported: model.input.includes("image"),
        imageFallback: {
          enabled: deps.guildConfig.imageReading.fallbackEnabled,
          model: deps.guildConfig.imageReading.fallbackModel,
          apiKey: imageStreamOptions.apiKey,
          providerParams: imageProviderParams,
          complete,
          llmOutputTimeoutMs: deps.guildConfig.replyLoop.llmOutputTimeoutMs,
          requestLog: reqLog,
          signal: wallController.signal,
          log: deps.log,
        },
        signal: wallController.signal,
      });
      finalText = result.text;
      targetChatId = result.targetChatId;
    } finally {
      clearTimeout(wallTimeout);
    }

    const parsedResponse = parseResponseDirectives(finalText);
    if (parsedResponse.ignored) {
      deps.log?.debug("native_reply_ignored", { durationMs: Date.now() - startedAt });
      return { triggered: true, triggerResult, agentRan: true };
    }
    if (parsedResponse.segments.length === 0) {
      deps.log?.debug("native_reply_empty_after_directives", { durationMs: Date.now() - startedAt });
      return { triggered: true, triggerResult, agentRan: true };
    }

    await sendResponseSegments({
      sender: deps.sender,
      generateSpeech: deps.generateSpeech,
      ttsEnabled: deps.ttsEnabled ?? false,
      segments: parsedResponse.segments,
      replyFirst: !intermediateStatus.sent && chooseReplyMode(triggerResult),
      targetChatId,
      requestLog: reqLog,
      log: deps.log,
      signal: wallController.signal,
    });

    const memoryReply = renderSegmentsForMemory(parsedResponse.segments);
    void deps.afterReply?.({
      sourceMessageId: msg.messageId,
      userMessage: userContent,
      assistantReply: memoryReply,
      recentContext: memoryExtractionContext(context),
    }).catch((error: unknown) => {
      deps.log?.warn("memory extraction failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    deps.log?.debug("native_reply_loop_end", {
      durationMs: Date.now() - startedAt,
      outputLength: memoryReply.length,
    });
    return { triggered: true, triggerResult, agentRan: true, responseText: memoryReply };
  } finally {
    deps.onAgentEnd?.();
  }
}
