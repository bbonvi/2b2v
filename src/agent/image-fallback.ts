import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { LlmProvider } from "../config/types.ts";
import type { Logger, RequestLog } from "../logger.ts";
import type { ModelImageInputSupport } from "../llm/client.ts";
import type { OpenRouterImageUrlPart, OpenRouterMessage, OpenRouterTextPart, OpenRouterToolCall } from "../llm/types.ts";
import type { ChatCompleteFn } from "./turn-types.ts";
import { completeModelTurnWithRetries, isRecord, makeToolErrorText } from "./model-retry.ts";

export function summarizeToolResult(result: AgentToolResult<unknown>): string {
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

export function imagePartsFromToolResult(result: AgentToolResult<unknown>): OpenRouterImageUrlPart[] {
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

export interface ImageFallbackRuntime {
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

export interface ImageFollowUpSource {
  toolCallId: string;
  toolName: string;
  metadataText: string;
}

const FALLBACK_IMAGE_DESCRIPTION_SYSTEM_PROMPT = "Describe image pixels for a chat model that cannot read image input.";

export function imageFollowUpMessage(
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

export function textFromMessageParts(message: OpenRouterMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is OpenRouterTextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export async function describeImagesWithFallback(input: {
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

export async function replaceUnsupportedImageMessages(
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

export function isImageInputUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("No endpoints found that support image input")
    || message.includes("does not support image input")
    || message.includes("cannot read image input")
    || message.includes("Invalid value: 'input_image'. Supported values are: 'input_text'.")
    || message.includes('Invalid value: "input_image". Supported values are: "input_text".');
}

export function appendImageUnsupportedToolText(text: string, imageCount: number): string {
  const notice = `Image reading failed because the current LLM endpoint cannot read image input, so ${imageCount === 1 ? "the image was" : "the images were"} not sent; use available text metadata or say images cannot be inspected with this model.`;
  return text.trim() === "" ? notice : `${text.trim()}\n\n${notice}`;
}

export function supportsNativeImageInput(
  modelInput: readonly string[],
  metadataSupport: ModelImageInputSupport | undefined,
): boolean {
  if (metadataSupport === "supported" || metadataSupport === "unknown") return true;
  if (metadataSupport === "unsupported") return false;
  return modelInput.includes("image");
}
