import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { randomUUID } from "node:crypto";
import { arch, platform, release } from "node:os";
import { getCodexApiKey } from "../llm/codex-auth.ts";
import type { Logger } from "../logger.ts";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_IMAGES_GENERATIONS_URL = "https://chatgpt.com/backend-api/codex/images/generations";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const OPENAI_BETA_HEADER = "responses=experimental";
const DEFAULT_OUTPUT_FORMAT = "png";
const BACKEND_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_IMAGE_SIZE = "auto";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DIAGNOSTIC_EVENTS = 80;
const MAX_DIAGNOSTIC_STRING_LENGTH = 2000;

const CodexGenerateImageParams = Type.Object({
  prompt: Type.String({
    description:
      "The final visual brief sent to Codex image generation. Preserve the user's exact visual request, relevant context, concrete subject/composition/style/lighting constraints, and avoid-list. Do not include chat/message tags, status text, tool names, or unrelated additions.",
  }),
  output_format: Type.Optional(Type.Union([
    Type.Literal("png"),
    Type.Literal("jpeg"),
    Type.Literal("webp"),
  ], {
    description: "Output image format. Defaults to png.",
  })),
});

type OutputFormat = "png" | "jpeg" | "webp";

export interface GeneratedImageAttachment {
  id: string;
  buffer: Buffer;
  filename: string;
  contentType: string;
  prompt: string;
  revisedPrompt?: string;
}

export interface CodexGenerateImageToolDeps {
  codexAuthPath: string;
  model: string;
  sessionId?: string;
  enableDirectImageFallback?: boolean;
  fetchFn?: typeof fetch;
  logger?: Logger;
  onGeneratedImage: (attachment: GeneratedImageAttachment) => void;
}

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
  transport: "responses-tool" | "direct-images";
}

function isRecord(value: unknown): value is Record<string, unknown> {
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

function extensionForFormat(outputFormat: OutputFormat): string {
  return outputFormat === "jpeg" ? "jpg" : outputFormat;
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
  sessionId?: string;
}): Record<string, unknown> {
  return {
    model: input.model,
    store: false,
    stream: true,
    ...(input.sessionId !== undefined ? { prompt_cache_key: input.sessionId } : {}),
    instructions: "You are an image generation assistant.",
    input: [{
      role: "user",
      content: [{ type: "input_text", text: input.prompt }],
    }],
    tools: [{
      type: "image_generation",
      model: BACKEND_IMAGE_MODEL,
      output_format: input.outputFormat,
      moderation: "low",
      quality: "auto",
      size: DEFAULT_IMAGE_SIZE,
    }],
    tool_choice: { type: "image_generation" },
    parallel_tool_calls: false,
    text: { verbosity: "low" },
  };
}

export function buildCodexDirectImageRequestBody(input: {
  prompt: string;
}): Record<string, unknown> {
  return {
    prompt: input.prompt,
    model: BACKEND_IMAGE_MODEL,
    n: 1,
    quality: "auto",
    size: DEFAULT_IMAGE_SIZE,
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
  sessionId?: string;
  fetchFn: typeof fetch;
  signal?: AbortSignal;
}): Promise<ParsedCodexResponse> {
  const body = JSON.stringify(buildCodexImageRequestBody(input));
  const headers = buildCodexHeaders(input);

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

async function requestImage(input: {
  prompt: string;
  token: string;
  accountId: string;
  model: string;
  outputFormat: OutputFormat;
  sessionId?: string;
  enableDirectImageFallback?: boolean;
  fetchFn: typeof fetch;
  signal?: AbortSignal;
  logger?: Logger;
}): Promise<ParsedImageResult> {
  const responsesParsed = await requestResponsesImage(input);
  applyPartialImageFallback(responsesParsed);
  if (responsesParsed.image !== undefined) {
    return { ...responsesParsed, transport: "responses-tool" };
  }

  input.logger?.warn("codex responses image route returned no image", {
    model: input.model,
    backendImageModel: BACKEND_IMAGE_MODEL,
    outputFormat: input.outputFormat,
    responseId: responsesParsed.responseId,
    failure: responsesParsed.failure,
    failureEvent: responsesParsed.failureEvent,
    responseText: responsesParsed.text.join("").trim(),
    responseHeaders: responsesParsed.responseHeaders,
    diagnosticEvents: responsesParsed.diagnosticEvents,
  });

  if (input.outputFormat !== "png" || input.enableDirectImageFallback !== true) {
    return { ...responsesParsed, transport: "responses-tool" };
  }

  input.logger?.warn("trying Codex direct image route after responses route returned no image", {
    model: input.model,
    backendImageModel: BACKEND_IMAGE_MODEL,
    outputFormat: input.outputFormat,
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
      responsesFailure: codexFailureMessage(responsesParsed),
      directFailure,
    });
    throw new Error(`${codexFailureMessage(responsesParsed)} Direct fallback failed: ${directFailure}`);
  }
}

function outputFormat(value: unknown): OutputFormat {
  return value === "jpeg" || value === "webp" || value === "png" ? value : DEFAULT_OUTPUT_FORMAT;
}

/** Create a tool that generates images through Codex subscription image_generation. */
export function createCodexGenerateImageTool(deps: CodexGenerateImageToolDeps): AgentTool {
  return {
    name: "codex_generate_image",
    label: "Codex Image",
    description: [
      "Generate an image with OpenAI Codex's built-in image_generation tool using the ChatGPT/Codex subscription backend. Does not require OPENAI_API_KEY.",
      "Use this only when the user asks for a raster image, photo, illustration, sprite, icon draft, banner, mockup, or similar bitmap output.",
      "Before calling, turn the user's request into a concrete image prompt. Preserve explicit requirements, add useful visual specifics for vague requests, and avoid inventing unrelated subjects, brands, text, or narrative details.",
      "The generated image will be attached to the final Discord reply automatically.",
    ].join(" "),
    parameters: CodexGenerateImageParams,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<{
      generatedAttachmentIds: string[];
      provider: "openai-codex";
      model: string;
      backendImageModel: "gpt-image-2";
      outputFormat: OutputFormat;
      responseId?: string;
      imageGenerationId?: string;
      revisedPrompt?: string;
      transport: "responses-tool" | "direct-images";
      usage?: unknown;
    }>> {
      const p = params as { prompt: string; output_format?: unknown };
      const prompt = p.prompt.trim();
      if (prompt === "") throw new Error("Image prompt must not be empty.");
      const output = outputFormat(p.output_format);
      const token = await getCodexApiKey(deps.codexAuthPath);
      const accountId = extractChatGptAccountId(token);
      const parsed = await requestImage({
        prompt,
        token,
        accountId,
        model: deps.model,
        outputFormat: output,
        sessionId: deps.sessionId,
        enableDirectImageFallback: deps.enableDirectImageFallback,
        fetchFn: deps.fetchFn ?? fetch,
        signal,
        logger: deps.logger,
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
          throw new Error(codexFailureMessage(parsed));
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
        throw new Error(codexFailureMessage(parsed));
      }

      const attachmentId = randomUUID();
      const filename = `codex-image-${attachmentId}.${extensionForFormat(output)}`;
      const buffer = Buffer.from(parsed.image.result, "base64");
      deps.onGeneratedImage({
        id: attachmentId,
        buffer,
        filename,
        contentType: mimeForFormat(output),
        prompt,
        revisedPrompt: parsed.image.revisedPrompt,
      });

      const summary = [
        `Generated image via openai-codex/${deps.model} using backend ${BACKEND_IMAGE_MODEL}.`,
        `Transport: ${parsed.transport}.`,
        `Attachment ID: ${attachmentId}.`,
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
          responseId: parsed.responseId,
          imageGenerationId: parsed.image.id,
          revisedPrompt: parsed.image.revisedPrompt,
          transport: parsed.transport,
          usage: parsed.usage,
        },
      };
    },
  };
}
