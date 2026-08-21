// import { arch, platform, release } from "node:os";
import type { ImageGenerationQuality } from "../config/types.ts";
import type { Logger } from "../logger.ts";
import { CODEX_IMAGE_GENERATION_INSTRUCTIONS } from "./codex-image-prompts.ts";
import {
  calculate4kImageSize,
  formatImageSize,
  infer4kAspectRatio,
} from "./codex-image-size.ts";
import type { ReferenceImageInput } from "./codex-image-tool.ts";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_IMAGES_GENERATIONS_URL = "https://chatgpt.com/backend-api/codex/images/generations";
const CODEX_IMAGES_EDITS_URL = "https://chatgpt.com/backend-api/codex/images/edits";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
// const CODEX_CLI_VERSION = "0.146.0";
const DEFAULT_OUTPUT_FORMAT = "webp";
export const BACKEND_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_IMAGE_SIZE = "auto";
const FOUR_K_IMAGE_QUALITY: ImageGenerationQuality = "high";
const DEFAULT_IMAGE_QUALITY: ImageGenerationQuality = "auto";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DIAGNOSTIC_EVENTS = 80;
const MAX_DIAGNOSTIC_STRING_LENGTH = 2000;

export type OutputFormat = "png" | "jpeg" | "webp";
export type ImageTransport = "responses-tool" | "direct-images" | "direct-edits";

export interface ParsedCodexResponse {
  image?: {
    id: string;
    status: string;
    result: string;
    revisedPrompt?: string;
  };
  lastPartialImage?: string;
  failure?: string;
  failureEvent?: unknown;
  diagnosticEvents: unknown[];
  responseHeaders?: Record<string, string>;
  text: string[];
  responseId?: string;
  usage?: unknown;
}

export interface ParsedImageResult extends ParsedCodexResponse {
  transport: ImageTransport;
  requestedSize?: string;
  actualSize?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined || payload === "") {
    throw new Error("OpenAI Codex auth token is not a JWT. Run codex:login again.");
  }
  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("OpenAI Codex auth token payload is not an object. Run codex:login again.");
  }
  return parsed;
}

export function extractChatGptAccountId(token: string): string {
  const payload = decodeJwtPayload(token);
  const authClaims = payload[JWT_CLAIM_PATH];
  if (!isRecord(authClaims)) {
    throw new Error("OpenAI Codex auth token does not contain ChatGPT auth claims. Run codex:login again.");
  }
  const accountId = authClaims.chatgpt_account_id;
  if (typeof accountId !== "string" || accountId === "") {
    throw new Error("OpenAI Codex auth token does not contain chatgpt_account_id. Run codex:login again.");
  }
  return accountId;
}

export function mimeForFormat(outputFormat: OutputFormat): string {
  return outputFormat === "jpeg" ? "image/jpeg" : `image/${outputFormat}`;
}

function redactDiagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth-limit]";
  if (typeof value === "string") {
    return value.length > MAX_DIAGNOSTIC_STRING_LENGTH
      ? `${value.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH)}…`
      : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactDiagnosticValue(item, depth + 1));
  }
  if (!isRecord(value)) return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (
      lower === "result"
      || lower === "partial_image_b64"
      || lower === "b64_json"
      || lower === "image_url"
      || lower === "authorization"
      || lower === "token"
      || lower === "api_key"
    ) {
      redacted[key] = "[redacted]";
      continue;
    }
    redacted[key] = redactDiagnosticValue(nestedValue, depth + 1);
  }
  return redacted;
}

function recordDiagnosticEvent(parsed: ParsedCodexResponse, event: unknown): void {
  if (parsed.diagnosticEvents.length >= MAX_DIAGNOSTIC_EVENTS) return;
  parsed.diagnosticEvents.push(redactDiagnosticValue(event));
}

function diagnosticHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const key of [
    "x-request-id",
    "openai-request-id",
    "cf-ray",
    "x-envoy-upstream-service-time",
  ]) {
    const value = response.headers.get(key);
    if (value !== null && value !== "") headers[key] = value;
  }
  return headers;
}

export function buildCodexImageRequestBody(input: {
  prompt: string;
  model: string;
  outputFormat: OutputFormat;
  imageGenerationQuality?: ImageGenerationQuality;
  referenceImages?: ReferenceImageInput[];
  sessionId?: string;
}): Record<string, unknown> {
  const referenceImages = input.referenceImages ?? [];
  const quality = input.imageGenerationQuality ?? DEFAULT_IMAGE_QUALITY;
  if (referenceImages.length > 0) {
    throw new Error("Codex Responses image requests do not support reference image inputs; use the direct image edit route.");
  }
  const content: Record<string, unknown>[] = [
    { type: "input_text", text: input.prompt },
  ];

  return {
    model: input.model,
    store: false,
    stream: true,
    instructions: CODEX_IMAGE_GENERATION_INSTRUCTIONS,
    input: [{
      role: "user",
      content,
    }],
    tools: [{
      type: "image_generation",
      model: BACKEND_IMAGE_MODEL,
      action: referenceImages.length > 0 ? "auto" : "generate",
      output_format: input.outputFormat,
      moderation: "low",
      quality,
      size: DEFAULT_IMAGE_SIZE,
    }],
    tool_choice: { type: "image_generation" },
    parallel_tool_calls: false,
    text: { verbosity: "low" },
  };
}

export function buildCodexDirectImageRequestBody(input: {
  prompt: string;
  model?: string;
  imageGenerationQuality?: ImageGenerationQuality;
  size?: string;
  outputFormat?: OutputFormat;
}): Record<string, unknown> {
  return {
    prompt: input.prompt,
    model: input.model ?? BACKEND_IMAGE_MODEL,
    n: 1,
    quality: input.imageGenerationQuality ?? DEFAULT_IMAGE_QUALITY,
    size: input.size ?? DEFAULT_IMAGE_SIZE,
    output_format: input.outputFormat ?? DEFAULT_OUTPUT_FORMAT,
  };
}

export function buildCodexDirectImageEditRequestBody(input: {
  prompt: string;
  referenceImages: ReferenceImageInput[];
  model?: string;
  imageGenerationQuality?: ImageGenerationQuality;
  size?: string;
  outputFormat?: OutputFormat;
}): Record<string, unknown> {
  return {
    prompt: input.prompt,
    model: input.model ?? BACKEND_IMAGE_MODEL,
    n: 1,
    quality: input.imageGenerationQuality ?? DEFAULT_IMAGE_QUALITY,
    size: input.size ?? DEFAULT_IMAGE_SIZE,
    output_format: input.outputFormat ?? DEFAULT_OUTPUT_FORMAT,
    images: input.referenceImages.map((image) => ({
      image_url: `data:${image.mimeType};base64,${image.data}`,
    })),
  };
}

function parseSseDataLines(chunk: string): string | undefined {
  const data = chunk
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n")
    .trim();
  return data !== "" && data !== "[DONE]" ? data : undefined;
}

function imageFromRecord(record: Record<string, unknown>): ParsedCodexResponse["image"] | undefined {
  if (record.type !== "image_generation_call") return undefined;
  if (typeof record.result !== "string" || record.result === "") return undefined;
  return {
    id: typeof record.id === "string" && record.id !== "" ? record.id : "image_generation",
    // A non-empty result is the completed image. Some Responses events retain
    // the earlier "generating" item status even after adding the final bytes.
    status: "completed",
    result: record.result,
    ...(typeof record.revised_prompt === "string" ? { revisedPrompt: record.revised_prompt } : {}),
  };
}

function findImageInValue(value: unknown): ParsedCodexResponse["image"] | undefined {
  if (isRecord(value)) {
    const direct = imageFromRecord(value);
    if (direct !== undefined) return direct;
    for (const item of Object.values(value)) {
      const nested = findImageInValue(item);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findImageInValue(item);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function handleCodexEvent(event: unknown, parsed: ParsedCodexResponse): void {
  if (!isRecord(event)) return;
  recordDiagnosticEvent(parsed, event);
  const type = event.type;
  if (typeof type !== "string") return;

  if (type === "error") {
    const message = typeof event.message === "string" ? event.message : undefined;
    const code = typeof event.code === "string" ? event.code : undefined;
    throw new Error(`Codex error: ${message ?? code ?? JSON.stringify(event)}`);
  }

  if (type === "response.failed") {
    const response = isRecord(event.response) ? event.response : undefined;
    const error = isRecord(response?.error) ? response.error : undefined;
    const message = typeof error?.message === "string" ? error.message : undefined;
    throw new Error(message ?? "Codex response failed.");
  }

  if (type === "response.created" || type === "response.completed" || type === "response.done") {
    const response = isRecord(event.response) ? event.response : undefined;
    if (typeof response?.id === "string") parsed.responseId = response.id;
    if ((type === "response.completed" || type === "response.done") && response?.usage !== undefined) {
      parsed.usage = response.usage;
    }
    const image = findImageInValue(response);
    if (image !== undefined) parsed.image = image;
    return;
  }

  if (type === "response.image_generation_call.partial_image") {
    if (typeof event.partial_image_b64 === "string" && event.partial_image_b64 !== "") {
      parsed.lastPartialImage = event.partial_image_b64;
    }
    return;
  }

  if (type === "response.image_generation_call.completed") {
    const image = findImageInValue(event);
    if (image !== undefined) parsed.image = image;
    return;
  }

  if (type === "response.output_text.delta") {
    if (typeof event.delta === "string") parsed.text.push(event.delta);
    return;
  }

  if (type !== "response.output_item.done") return;
  const item = isRecord(event.item) ? event.item : undefined;
  if (item?.type !== "image_generation_call") return;
  const image = imageFromRecord(item);
  if (image !== undefined) {
    parsed.image = image;
    return;
  }
  if (item.status === "failed") {
    const error = isRecord(item.error) && typeof item.error.message === "string"
      ? item.error.message
      : JSON.stringify(item);
    parsed.failure = error;
    parsed.failureEvent = redactDiagnosticValue(event);
  }
}

/** Parse Codex Responses SSE events and extract generated image output. */
export async function parseCodexImageSse(response: Response, signal?: AbortSignal): Promise<ParsedCodexResponse> {
  if (response.body === null) throw new Error("Codex response did not include a stream body.");
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parsed: ParsedCodexResponse = { text: [], diagnosticEvents: [] };

  try {
    for (;;) {
      if (signal?.aborted === true) throw new Error("Image generation was aborted.");
      const read = await reader.read();
      const done = read.done;
      const value = read.value;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const chunk = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const data = parseSseDataLines(chunk);
        if (data !== undefined) handleCodexEvent(JSON.parse(data) as unknown, parsed);
        separator = buffer.indexOf("\n\n");
      }
    }

    const remaining = parseSseDataLines(buffer);
    if (remaining !== undefined) handleCodexEvent(JSON.parse(remaining) as unknown, parsed);
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Stream may already be closed.
    }
    reader.releaseLock();
  }

  return parsed;
}

export function buildCodexHeaders(input: {
  token: string;
  accountId: string;
  sessionId?: string;
  accept?: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${input.token}`,
    "chatgpt-account-id": input.accountId,
    // Disabled because these headers make this client identify as Codex CLI.
    // originator: "codex_cli_rs",
    // version: CODEX_CLI_VERSION,
    // "User-Agent": `codex_cli_rs/${CODEX_CLI_VERSION} (${platform()} ${release()}; ${arch()})`,
    accept: input.accept ?? "text/event-stream",
    "content-type": "application/json",
    ...(input.sessionId !== undefined ? { session_id: input.sessionId } : {}),
  };
}

export function buildCodexResponsesImageHeaders(input: {
  token: string;
  accountId: string;
}): Record<string, string> {
  return buildCodexHeaders({
    token: input.token,
    accountId: input.accountId,
  });
}

function isRetryableStatus(status: number, errorText: string): boolean {
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const abortSignal = signal;
    if (abortSignal?.aborted === true) {
      reject(abortSignal.reason instanceof Error ? abortSignal.reason : new Error("Image generation was aborted."));
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timeout);
      cleanup();
      reject(abortSignal?.reason instanceof Error ? abortSignal.reason : new Error("Image generation was aborted."));
    };
    const cleanup = (): void => {
      abortSignal?.removeEventListener("abort", onAbort);
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffMs(attempt: number): number {
  return BASE_DELAY_MS * 2 ** (attempt - 1) * (0.9 + Math.random() * 0.2);
}

async function requestResponsesImage(input: {
  prompt: string;
  token: string;
  accountId: string;
  model: string;
  outputFormat: OutputFormat;
  imageGenerationQuality: ImageGenerationQuality;
  referenceImages: ReferenceImageInput[];
  sessionId?: string;
  fetchFn: typeof fetch;
  signal?: AbortSignal;
}): Promise<ParsedCodexResponse> {
  const body = JSON.stringify(buildCodexImageRequestBody(input));
  const headers = buildCodexResponsesImageHeaders({
    token: input.token,
    accountId: input.accountId,
  });

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
    if (input.signal?.aborted === true) throw new Error("Image generation was aborted.");

    const response = await input.fetchFn(CODEX_RESPONSES_URL, {
      method: "POST",
      headers,
      body,
      signal: input.signal,
    });

    if (response.ok) {
      const parsed = await parseCodexImageSse(response, input.signal);
      parsed.responseHeaders = diagnosticHeaders(response);
      return parsed;
    }

    const errorText = await response.text();
    if (attempt <= MAX_RETRIES && isRetryableStatus(response.status, errorText)) {
      await sleepMs(backoffMs(attempt), input.signal);
      continue;
    }
    throw new Error(`Codex image generation request failed (${response.status}): ${errorText}`);
  }

  throw new Error("Codex image generation request failed after all retries.");
}

export function parseCodexDirectImageResponse(value: unknown): ParsedCodexResponse {
  const parsed: ParsedCodexResponse = { text: [], diagnosticEvents: [] };
  recordDiagnosticEvent(parsed, value);
  if (!isRecord(value)) throw new Error("Codex direct image generation response was not an object.");
  const data = Array.isArray(value.data) ? value.data : undefined;
  const first = data?.find((item): item is Record<string, unknown> => isRecord(item));
  if (first === undefined) throw new Error("Codex direct image generation returned no image data.");
  const b64Json = first.b64_json;
  if (typeof b64Json !== "string" || b64Json === "") {
    throw new Error("Codex direct image generation returned no image data.");
  }
  parsed.image = {
    id: typeof first.id === "string" && first.id !== "" ? first.id : "image_generation_direct",
    status: "completed",
    result: b64Json,
    ...(typeof first.revised_prompt === "string" ? { revisedPrompt: first.revised_prompt } : {}),
  };
  if (value.usage !== undefined) parsed.usage = value.usage;
  return parsed;
}

async function requestDirectImage(input: {
  prompt: string;
  imageGenerationQuality: ImageGenerationQuality;
  size?: string;
  outputFormat: OutputFormat;
  token: string;
  accountId: string;
  fetchFn: typeof fetch;
  signal?: AbortSignal;
}): Promise<ParsedCodexResponse> {
  const body = JSON.stringify(buildCodexDirectImageRequestBody({
    prompt: input.prompt,
    imageGenerationQuality: input.imageGenerationQuality,
    size: input.size,
    outputFormat: input.outputFormat,
  }));
  const headers = buildCodexHeaders({
    token: input.token,
    accountId: input.accountId,
    accept: "application/json",
  });

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
    if (input.signal?.aborted === true) throw new Error("Image generation was aborted.");

    const response = await input.fetchFn(CODEX_IMAGES_GENERATIONS_URL, {
      method: "POST",
      headers,
      body,
      signal: input.signal,
    });

    if (response.ok) {
      const parsed = parseCodexDirectImageResponse(await response.json());
      parsed.responseHeaders = diagnosticHeaders(response);
      return parsed;
    }

    const errorText = await response.text();
    if (attempt <= MAX_RETRIES && isRetryableStatus(response.status, errorText)) {
      await sleepMs(backoffMs(attempt), input.signal);
      continue;
    }
    throw new Error(`Codex direct image generation request failed (${response.status}): ${errorText}`);
  }

  throw new Error("Codex direct image generation request failed after all retries.");
}

async function requestDirectImageEdit(input: {
  prompt: string;
  imageGenerationQuality: ImageGenerationQuality;
  size?: string;
  outputFormat: OutputFormat;
  referenceImages: ReferenceImageInput[];
  token: string;
  accountId: string;
  fetchFn: typeof fetch;
  signal?: AbortSignal;
}): Promise<ParsedCodexResponse> {
  const body = JSON.stringify(buildCodexDirectImageEditRequestBody({
    prompt: input.prompt,
    imageGenerationQuality: input.imageGenerationQuality,
    size: input.size,
    outputFormat: input.outputFormat,
    referenceImages: input.referenceImages,
  }));
  const headers = buildCodexHeaders({
    token: input.token,
    accountId: input.accountId,
    accept: "application/json",
  });

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
    if (input.signal?.aborted === true) throw new Error("Image generation was aborted.");

    const response = await input.fetchFn(CODEX_IMAGES_EDITS_URL, {
      method: "POST",
      headers,
      body,
      signal: input.signal,
    });

    if (response.ok) {
      const parsed = parseCodexDirectImageResponse(await response.json());
      parsed.responseHeaders = diagnosticHeaders(response);
      return parsed;
    }

    const errorText = await response.text();
    if (attempt <= MAX_RETRIES && isRetryableStatus(response.status, errorText)) {
      await sleepMs(backoffMs(attempt), input.signal);
      continue;
    }
    throw new Error(`Codex direct image edit request failed (${response.status}): ${errorText}`);
  }

  throw new Error("Codex direct image edit request failed after all retries.");
}

function applyPartialImageFallback(parsed: ParsedCodexResponse): void {
  if (parsed.image !== undefined || parsed.lastPartialImage === undefined) return;
  parsed.image = {
    id: "image_generation_partial",
    status: "partial",
    result: parsed.lastPartialImage,
  };
}

export function codexFailureMessage(parsed: ParsedCodexResponse): string {
  const text = parsed.text.join("").trim();
  if (parsed.failure !== undefined) {
    const responseText = text !== "" ? ` Response text: ${text}` : "";
    return `Codex image generation failed: ${parsed.failure}${responseText}`;
  }
  return text !== "" ? `Codex did not return an image. Response text: ${text}` : "Codex did not return an image.";
}

export function codexImageFailureMessageForAgent(message: string): string {
  return message;
}

export async function requestImage(input: {
  prompt: string;
  token: string;
  accountId: string;
  model: string;
  outputFormat: OutputFormat;
  imageGenerationQuality: ImageGenerationQuality;
  is4k: boolean;
  referenceImages: ReferenceImageInput[];
  sessionId?: string;
  enableDirectImageFallback?: boolean;
  fetchFn: typeof fetch;
  signal?: AbortSignal;
  logger?: Logger;
}): Promise<ParsedImageResult> {
  if (input.is4k) {
    const aspect = input.referenceImages[0] !== undefined
      ? { width: input.referenceImages[0].width, height: input.referenceImages[0].height }
      : infer4kAspectRatio(input.prompt);
    const size = formatImageSize(calculate4kImageSize(aspect));
    input.logger?.info("requesting Codex 4K image route", {
      model: input.model,
      backendImageModel: BACKEND_IMAGE_MODEL,
      outputFormat: input.outputFormat,
      is4k: true,
      transport: input.referenceImages.length > 0 ? "direct-edits" : "direct-images",
      requestedSize: size,
      referenceImageIds: input.referenceImages.map((image) => image.id),
    });
    const directInput = {
      ...input,
      imageGenerationQuality: FOUR_K_IMAGE_QUALITY,
      size,
    };
    const parsed = input.referenceImages.length > 0
      ? await requestDirectImageEdit(directInput)
      : await requestDirectImage(directInput);
    return {
      ...parsed,
      transport: input.referenceImages.length > 0 ? "direct-edits" : "direct-images",
      requestedSize: size,
    };
  }

  if (input.referenceImages.length > 0) {
    input.logger?.info("requesting Codex direct image edit route for reference images", {
      model: input.model,
      backendImageModel: BACKEND_IMAGE_MODEL,
      outputFormat: input.outputFormat,
      is4k: false,
      transport: "direct-edits",
      referenceImageIds: input.referenceImages.map((image) => image.id),
    });
    const parsed = await requestDirectImageEdit(input);
    return { ...parsed, transport: "direct-edits" };
  }

  const responsesParsed = await requestResponsesImage(input);
  applyPartialImageFallback(responsesParsed);
  if (responsesParsed.image !== undefined) {
    return { ...responsesParsed, transport: "responses-tool" };
  }

  input.logger?.warn("codex responses image route returned no image", {
    model: input.model,
    backendImageModel: BACKEND_IMAGE_MODEL,
    outputFormat: input.outputFormat,
    is4k: input.is4k,
    responseId: responsesParsed.responseId,
    failure: responsesParsed.failure,
    failureEvent: responsesParsed.failureEvent,
    responseText: responsesParsed.text.join("").trim(),
    responseHeaders: responsesParsed.responseHeaders,
    diagnosticEvents: responsesParsed.diagnosticEvents,
  });

  if (input.referenceImages.length > 0 || input.enableDirectImageFallback !== true) {
    return { ...responsesParsed, transport: "responses-tool" };
  }

  input.logger?.warn("trying Codex direct image route after responses route returned no image", {
    model: input.model,
    backendImageModel: BACKEND_IMAGE_MODEL,
    outputFormat: input.outputFormat,
    is4k: input.is4k,
    responseId: responsesParsed.responseId,
  });

  try {
    const directParsed = await requestDirectImage(input);
    return { ...directParsed, transport: "direct-images" };
  } catch (error) {
    const directFailure = error instanceof Error ? error.message : String(error);
    input.logger?.warn("codex direct image route failed after responses route returned no image", {
      model: input.model,
      backendImageModel: BACKEND_IMAGE_MODEL,
      outputFormat: input.outputFormat,
      is4k: input.is4k,
      responsesFailure: codexFailureMessage(responsesParsed),
      directFailure,
    });
    throw new Error(`${codexFailureMessage(responsesParsed)} Direct fallback failed: ${directFailure}`);
  }
}
