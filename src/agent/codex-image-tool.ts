import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { createHash, randomUUID } from "node:crypto";
import { arch, platform, release } from "node:os";
import sharp from "sharp";
import { getCodexApiKey } from "../llm/codex-auth.ts";
import type { Logger } from "../logger.ts";
import type { EnqueueImageJobResult } from "./job-runtime.ts";
import type { ImageGenerationQuality } from "../config/types.ts";
import { imageExtensionForMime, imageMimeFromBuffer } from "../db/image-ingest.ts";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_IMAGES_GENERATIONS_URL = "https://chatgpt.com/backend-api/codex/images/generations";
const CODEX_IMAGES_EDITS_URL = "https://chatgpt.com/backend-api/codex/images/edits";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const OPENAI_BETA_HEADER = "responses=experimental";
const DEFAULT_OUTPUT_FORMAT = "webp";
const BACKEND_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_IMAGE_SIZE = "auto";
const FOUR_K_IMAGE_QUALITY: ImageGenerationQuality = "high";
const MAX_GPT_IMAGE_EDGE = 3840;
const MAX_GPT_IMAGE_PIXELS = 8_294_400;
const GPT_IMAGE_SIZE_MULTIPLE = 16;
const DEFAULT_IMAGE_QUALITY: ImageGenerationQuality = "auto";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DIAGNOSTIC_EVENTS = 80;
const MAX_DIAGNOSTIC_STRING_LENGTH = 2000;

const CodexGenerateImageParams = Type.Object({
  prompt: Type.String({
    description:
      "The final visual brief sent to Codex image generation. Preserve the user's visual request and concrete subject/composition/style/lighting constraints, but phrase it as a safe neutral image prompt. If retrying after a rejected/no-image attempt, rewrite the prompt instead of resending it exactly: remove or soften words that can be misread as sexual, violent, coercive, or logo/brand-mark-focused while keeping the intended subject and composition. Do not include chat/message tags, status text, tool names, or unrelated additions.",
  }),
  image_ids: Type.Optional(Type.Array(Type.Number(), {
    description:
      "Chat ImageIDs to pass as visual reference inputs. Include the user's attached image, replied-to image, or other specific context image when the request clearly depends on it.",
  })),
  output_format: Type.Optional(Type.Union([
    Type.Literal("png"),
    Type.Literal("jpeg"),
    Type.Literal("webp"),
  ], {
    description: "Output image format. Defaults to webp.",
  })),
  "4k": Type.Optional(Type.Boolean({
    description:
      "Set true only when the user explicitly asks for 4K, UHD, highest/maximum resolution, print-resolution, or a final high-resolution render. Leave false for ordinary high quality, detailed, HD, or good images.",
  })),
  separate_job: Type.Optional(Type.Boolean({
    description:
      "Set true only when the user explicitly asks for a separate new image/variant while another image job is active. Leave false for status checks, confusion, or duplicate requests.",
  })),
  allows_group_corrections: Type.Optional(Type.Boolean({
    description:
      "Set true only when the image request is explicitly about the whole chat/group/all visible users, so omitted participants can correct the still-young job.",
  })),
  replaces_job_id: Type.Optional(Type.String({
    description:
      "Set only after cancel_agent_job succeeds for a replacement. Use the cancelled job id being replaced.",
  })),
});

type OutputFormat = "png" | "jpeg" | "webp";
type ImageTransport = "responses-tool" | "direct-images" | "direct-edits";

export interface GeneratedImageAttachment {
  id: string;
  buffer: Buffer;
  filename: string;
  contentType: string;
  prompt: string;
  revisedPrompt?: string;
  requestedSize?: string;
  actualSize?: string;
  transport?: ImageTransport;
  is4k?: boolean;
}

interface ReferenceImageRecord {
  id: number;
  mime: string;
  width: number;
  height: number;
  path: string;
}

export interface ReferenceImageInput {
  id: number;
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface CodexGenerateImageToolDeps {
  codexAuthPath: string;
  model: string;
  sessionId?: string;
  enableDirectImageFallback?: boolean;
  fetchFn?: typeof fetch;
  logger?: Logger;
  imageReadMaxPerCall: number;
  imageGenerationQuality: ImageGenerationQuality;
  getImageById: (id: number) => ReferenceImageRecord | null;
  readFile: (path: string) => Buffer | null;
  onGeneratedImage: (attachment: GeneratedImageAttachment) => void;
  enqueueImageJob?: (input: {
    prompt: string;
    promptHash: string;
    imageIds: number[];
    outputFormat: OutputFormat;
    is4k: boolean;
    separateJob: boolean;
    allowsGroupCorrections: boolean;
    replacesJobId?: string;
  }) => EnqueueImageJobResult;
}

type CodexGenerateImageDetails =
  | {
    generatedAttachmentIds: string[];
    provider: "openai-codex";
    model: string;
    backendImageModel: "gpt-image-2";
    outputFormat: OutputFormat;
    is4k: boolean;
    referenceImageIds: number[];
    responseId?: string;
    imageGenerationId?: string;
    revisedPrompt?: string;
    transport: ImageTransport;
    requestedSize?: string;
    actualSize?: string;
    usage?: unknown;
  }
  | {
    asyncJobId: string;
    asyncJobStatus: string;
    asyncJobCreated: boolean;
    is4k: boolean;
    reason?: string;
  };

interface ParsedCodexResponse {
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

interface ParsedImageResult extends ParsedCodexResponse {
  transport: ImageTransport;
  requestedSize?: string;
  actualSize?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function promptHash(prompt: string, imageIds: readonly number[], is4k: boolean): string {
  return createHash("sha256")
    .update(normalizePrompt(prompt))
    .update("|")
    .update(imageIds.join(","))
    .update("|")
    .update(is4k ? "4k" : "standard")
    .digest("hex")
    .slice(0, 16);
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

function extractChatGptAccountId(token: string): string {
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

function mimeForFormat(outputFormat: OutputFormat): string {
  return outputFormat === "jpeg" ? "image/jpeg" : `image/${outputFormat}`;
}

export interface ImageSize {
  width: number;
  height: number;
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, " ");
}

function containsAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function infer4kAspectRatio(prompt: string): ImageSize {
  const text = normalizePrompt(prompt);
  const wantsWide = containsAny(text, [
    /\bwide\b/,
    /\blandscape\b/,
    /\bcinematic\b/,
    /\bbanner\b/,
    /\bwallpaper\b/,
    /\bwidescreen\b/,
    /\b16[:\s-]?9\b/,
  ]);
  if (wantsWide) return { width: 16, height: 9 };
  if (containsAny(text, [
    /\bvertical\b/,
    /\bportrait\b/,
    /\bselfie\b/,
    /\bphone\b/,
    /\bmobile\b/,
    /\b9[:\s-]?16\b/,
  ])) return { width: 9, height: 16 };
  if (containsAny(text, [
    /\bavatar\b/,
    /\bprofile\b/,
    /\bicon\b/,
    /\bsquare\b/,
    /\b1[:\s-]?1\b/,
  ])) return { width: 1, height: 1 };
  if (containsAny(text, [/\bposter\b/, /\bkey art\b/, /\bkeyart\b/])) return { width: 3, height: 2 };
  return { width: 1, height: 1 };
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

function reducedAspect(width: number, height: number): ImageSize {
  const divisor = gcd(width, height);
  return { width: width / divisor, height: height / divisor };
}

export function calculate4kImageSize(aspect: ImageSize): ImageSize {
  if (!Number.isFinite(aspect.width) || !Number.isFinite(aspect.height) || aspect.width <= 0 || aspect.height <= 0) {
    throw new Error("4K image aspect ratio must be positive.");
  }
  const reduced = reducedAspect(Math.round(aspect.width), Math.round(aspect.height));
  const ratio = Math.max(reduced.width, reduced.height) / Math.min(reduced.width, reduced.height);
  if (ratio > 3) throw new Error("4K image aspect ratio must be 3:1 or narrower.");
  if (reduced.width === 3 && reduced.height === 2) {
    const size = { width: 3520, height: 2336 };
    validate4kImageSize(size);
    return size;
  }
  if (reduced.width === 2 && reduced.height === 3) {
    const size = { width: 2336, height: 3520 };
    validate4kImageSize(size);
    return size;
  }

  const maxScaleByEdge = Math.floor(MAX_GPT_IMAGE_EDGE / Math.max(reduced.width, reduced.height));
  const maxScaleByPixels = Math.floor(Math.sqrt(MAX_GPT_IMAGE_PIXELS / (reduced.width * reduced.height)));
  let scale = Math.min(maxScaleByEdge, maxScaleByPixels);
  scale -= scale % GPT_IMAGE_SIZE_MULTIPLE;
  if (scale <= 0) throw new Error("4K image size could not satisfy backend constraints.");
  const size = {
    width: reduced.width * scale,
    height: reduced.height * scale,
  };
  validate4kImageSize(size);
  return size;
}

export function validate4kImageSize(size: ImageSize): void {
  if (size.width % GPT_IMAGE_SIZE_MULTIPLE !== 0 || size.height % GPT_IMAGE_SIZE_MULTIPLE !== 0) {
    throw new Error("4K image size edges must be multiples of 16.");
  }
  if (Math.max(size.width, size.height) > MAX_GPT_IMAGE_EDGE) {
    throw new Error("4K image size exceeds backend max edge.");
  }
  const ratio = Math.max(size.width, size.height) / Math.min(size.width, size.height);
  if (ratio > 3) throw new Error("4K image size exceeds backend aspect ratio limit.");
  if (size.width * size.height > MAX_GPT_IMAGE_PIXELS) {
    throw new Error("4K image size exceeds backend pixel limit.");
  }
}

function formatImageSize(size: ImageSize): string {
  return `${size.width}x${size.height}`;
}

async function imageSizeFromBuffer(buffer: Buffer): Promise<string | undefined> {
  try {
    const meta = await sharp(buffer).metadata();
    return `${meta.width}x${meta.height}`;
  } catch {
    return undefined;
  }
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
  const referenceSummary = referenceImages.length > 0
    ? [
      input.prompt,
      "",
      "Reference images from chat are attached below:",
      ...referenceImages.map((image, index) =>
        `Reference ${index + 1}: Chat ImageID ${image.id}, ${image.width}x${image.height}, ${image.mimeType}.`
      ),
    ].join("\n")
    : input.prompt;
  const content: Record<string, unknown>[] = [
    { type: "input_text", text: referenceSummary },
    ...referenceImages.map((image) => ({
      type: "input_image",
      detail: "auto",
      image_url: `data:${image.mimeType};base64,${image.data}`,
    })),
  ];

  return {
    model: input.model,
    store: false,
    stream: true,
    instructions: "You are an image generation assistant.",
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
    status: typeof record.status === "string" ? record.status : "completed",
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
    "OpenAI-Beta": OPENAI_BETA_HEADER,
    originator: "pi",
    "User-Agent": `pi (${platform()} ${release()}; ${arch()})`,
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
  const body = JSON.stringify(buildCodexDirectImageRequestBody(input));
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
  const body = JSON.stringify(buildCodexDirectImageEditRequestBody(input));
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

function codexFailureMessage(parsed: ParsedCodexResponse): string {
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

async function requestImage(input: {
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

function outputFormat(value: unknown): OutputFormat {
  return value === "jpeg" || value === "webp" || value === "png" ? value : DEFAULT_OUTPUT_FORMAT;
}

function parseImageIds(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("image_ids must be an array of chat image IDs.");
  const result: number[] = [];
  const seen = new Set<number>();
  for (const item of value) {
    if (typeof item !== "number" || !Number.isInteger(item) || item <= 0) {
      throw new Error("image_ids must contain positive integer chat image IDs.");
    }
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

function loadReferenceImages(deps: CodexGenerateImageToolDeps, imageIds: number[]): ReferenceImageInput[] {
  if (imageIds.length > deps.imageReadMaxPerCall) {
    throw new Error(`Too many reference image IDs requested (${imageIds.length}). Maximum is ${deps.imageReadMaxPerCall} per call.`);
  }

  const images: ReferenceImageInput[] = [];
  for (const id of imageIds) {
    const record = deps.getImageById(id);
    if (record === null) throw new Error(`Reference image ${id} was not found.`);
    const buffer = deps.readFile(record.path);
    if (buffer === null) throw new Error(`Reference image ${id} could not be read from storage.`);
    images.push({
      id: record.id,
      data: buffer.toString("base64"),
      mimeType: record.mime,
      width: record.width,
      height: record.height,
    });
  }
  return images;
}

/** Create a tool that generates images through Codex subscription image_generation. */
export function createCodexGenerateImageTool(deps: CodexGenerateImageToolDeps): AgentTool {
  return {
    name: "codex_generate_image",
    label: "Codex Image",
    description: [
      "Start image generation with OpenAI Codex's built-in image_generation tool using the ChatGPT/Codex subscription backend. Does not require OPENAI_API_KEY.",
      "In Discord runtime this starts an async image job and returns immediately; the generated image will be posted later by the runtime.",
      "Use this only when the user asks for a raster image, photo, illustration, sprite, icon draft, banner, mockup, or similar bitmap output.",
      "When the visual request is based on a specific chat image, include its ImageID in image_ids. This includes images attached in the user's current post, images on the replied-to message, or images clearly referenced from recent context. Include several ImageIDs when the request asks to combine or compare multiple specific images; omit image_ids only when the image is generic background context or irrelevant.",
      "Set 4k=true only when the user explicitly asks for 4K, UHD, highest/maximum resolution, print-resolution, or a final high-resolution render. Leave it false for ordinary high quality, detailed, HD, or good images. 4K requests can take roughly twice as long as normal image jobs.",
      "Before calling, turn the user's request into a concrete, safe, neutral image prompt. Preserve explicit visual requirements, add useful visual specifics for vague requests, and avoid inventing unrelated subjects, brands, text, or narrative details.",
      "Do not call this when an active image job already covers the same concrete request; answer with that job's status instead.",
      "If generation fails because Codex returns no image, rejects the prompt, or reports a safety/filter failure, the async worker will report failure. Retry only when the user asks, when you are certain a revised prompt will work, or when the current chat explicitly overrides the retry policy.",
      "The generated image will be attached to a later Discord reply automatically.",
    ].join(" "),
    parameters: CodexGenerateImageParams,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<CodexGenerateImageDetails>> {
      const p = params as {
        prompt: string;
        output_format?: unknown;
        "4k"?: unknown;
        image_ids?: unknown;
        separate_job?: unknown;
        allows_group_corrections?: unknown;
        replaces_job_id?: unknown;
      };
      const prompt = p.prompt.trim();
      if (prompt === "") throw new Error("Image prompt must not be empty.");
      const output = outputFormat(p.output_format);
      const is4k = p["4k"] === true;
      const imageIds = parseImageIds(p.image_ids);
      if (deps.enqueueImageJob !== undefined) {
        const replacesJobId = typeof p.replaces_job_id === "string" && p.replaces_job_id.trim() !== ""
          ? p.replaces_job_id.trim()
          : undefined;
        const enqueueResult = deps.enqueueImageJob({
          prompt,
          promptHash: promptHash(prompt, imageIds, is4k),
          imageIds,
          outputFormat: output,
          is4k,
          separateJob: p.separate_job === true,
          allowsGroupCorrections: p.allows_group_corrections === true,
          ...(replacesJobId !== undefined ? { replacesJobId } : {}),
        });
        if (!enqueueResult.created) {
          return {
            content: [{
              type: "text",
              text: [
                `No new image job was started. Active related image job ${enqueueResult.job.id} is ${enqueueResult.job.status}.`,
                "Do not call codex_generate_image again for the same request while this job is active.",
                "Answer the user with this status unless they explicitly asked for a separate variant or a valid replacement.",
              ].join(" "),
            }],
            details: {
              asyncJobId: enqueueResult.job.id,
              asyncJobStatus: enqueueResult.job.status,
              asyncJobCreated: false,
              is4k,
              reason: enqueueResult.reason,
            },
          };
        }
        return {
          content: [{
            type: "text",
            text: [
              `Started async image generation job ${enqueueResult.job.id}.`,
              "The job will keep typing in the channel and reply to the original message with the image when ready.",
              "Do not wait for the image in this reply loop and do not start another job for the same request.",
            ].join(" "),
          }],
          details: {
            asyncJobId: enqueueResult.job.id,
            asyncJobStatus: enqueueResult.job.status,
            asyncJobCreated: true,
            is4k,
          },
        };
      }
      const referenceImages = loadReferenceImages(deps, imageIds);
      const token = await getCodexApiKey(deps.codexAuthPath);
      const accountId = extractChatGptAccountId(token);
      const parsed = await requestImage({
        prompt,
        token,
        accountId,
        model: deps.model,
        outputFormat: output,
        is4k,
        imageGenerationQuality: deps.imageGenerationQuality,
        referenceImages,
        sessionId: deps.sessionId,
        enableDirectImageFallback: deps.enableDirectImageFallback,
        fetchFn: deps.fetchFn ?? fetch,
        signal,
        logger: deps.logger,
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(codexImageFailureMessageForAgent(message));
      });

      if (parsed.image === undefined) {
        if (parsed.failure !== undefined) {
          deps.logger?.warn("codex image generation failed", {
            model: deps.model,
            backendImageModel: BACKEND_IMAGE_MODEL,
            outputFormat: output,
            responseId: parsed.responseId,
            failure: parsed.failure,
            failureEvent: parsed.failureEvent,
            responseText: parsed.text.join("").trim(),
            responseHeaders: parsed.responseHeaders,
            diagnosticEvents: parsed.diagnosticEvents,
          });
          throw new Error(codexImageFailureMessageForAgent(codexFailureMessage(parsed)));
        }
        deps.logger?.warn("codex image generation returned no image", {
          model: deps.model,
          backendImageModel: BACKEND_IMAGE_MODEL,
          outputFormat: output,
          responseId: parsed.responseId,
          responseText: parsed.text.join("").trim(),
          responseHeaders: parsed.responseHeaders,
          diagnosticEvents: parsed.diagnosticEvents,
        });
        throw new Error(codexImageFailureMessageForAgent(codexFailureMessage(parsed)));
      }

      const buffer = Buffer.from(parsed.image.result, "base64");
      const actualMime = imageMimeFromBuffer(buffer, mimeForFormat(output));
      const actualSize = await imageSizeFromBuffer(buffer);
      const attachmentId = randomUUID();
      const filename = `codex-image-${attachmentId}.${imageExtensionForMime(actualMime)}`;
      deps.onGeneratedImage({
        id: attachmentId,
        buffer,
        filename,
        contentType: actualMime,
        prompt,
        revisedPrompt: parsed.image.revisedPrompt,
        requestedSize: parsed.requestedSize,
        actualSize,
        transport: parsed.transport,
        is4k,
      });

      const summary = [
        `Generated image via openai-codex/${deps.model} using backend ${BACKEND_IMAGE_MODEL}.`,
        `Transport: ${parsed.transport}.`,
        `4K: ${is4k ? "yes" : "no"}.`,
        parsed.requestedSize !== undefined ? `Requested size: ${parsed.requestedSize}.` : "",
        actualSize !== undefined ? `Actual size: ${actualSize}.` : "",
        `Attachment ID: ${attachmentId}.`,
        referenceImages.length > 0 ? `Reference ImageIDs: [${referenceImages.map((image) => image.id).join(", ")}].` : "",
        `Status: ${parsed.image.status}.`,
        parsed.image.revisedPrompt !== undefined ? `Revised prompt: ${parsed.image.revisedPrompt}` : "",
        "The generated image is queued and will be attached to the final Discord reply.",
      ].filter((part) => part !== "").join(" ");

      return {
        content: [{ type: "text", text: summary }],
        details: {
          generatedAttachmentIds: [attachmentId],
          provider: "openai-codex",
          model: deps.model,
          backendImageModel: BACKEND_IMAGE_MODEL,
          outputFormat: output,
          referenceImageIds: referenceImages.map((image) => image.id),
          responseId: parsed.responseId,
          imageGenerationId: parsed.image.id,
          revisedPrompt: parsed.image.revisedPrompt,
          transport: parsed.transport,
          is4k,
          requestedSize: parsed.requestedSize,
          actualSize,
          usage: parsed.usage,
        },
      };
    },
  };
}
