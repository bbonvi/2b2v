import { complete, stream } from "@earendil-works/pi-ai/compat";
import type {
  AssistantMessage,
  Context,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall as PiToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import { getCodexApiKey } from "./codex-auth.ts";
import { resolveModel } from "./client.ts";
import type {
  OpenRouterChatRequest,
  OpenRouterChatResult,
  OpenRouterImageUrlPart,
  OpenRouterMessage,
  ProviderNativeAssistantContent,
  OpenRouterTextPart,
  OpenRouterToolCall,
} from "./types.ts";

const DEFAULT_CODEX_AUTH_PATH = "data/codex-auth.json";

export type ModelFailureKind =
  | "transport"
  | "provider_transient"
  | "permanent"
  | "aborted";

/** Provider failure with retry semantics preserved across the LLM boundary. */
export class ModelProviderError extends Error {
  readonly kind: ModelFailureKind;
  readonly retryable: boolean;
  readonly transportCode?: number;

  constructor(message: string, input: {
    kind: ModelFailureKind;
    retryable: boolean;
    transportCode?: number;
    cause?: unknown;
  }) {
    super(message, input.cause !== undefined ? { cause: input.cause } : undefined);
    this.name = "ModelProviderError";
    this.kind = input.kind;
    this.retryable = input.retryable;
    if (input.transportCode !== undefined) this.transportCode = input.transportCode;
  }
}

const TRANSIENT_WEBSOCKET_CLOSE_CODES = new Set([1006, 1011, 1012, 1013]);
const PERMANENT_WEBSOCKET_CLOSE_CODES = new Set([1002, 1003, 1007, 1008, 1009]);

function websocketCloseCode(message: string): number | undefined {
  const match = /websocket[^\d]{0,32}(\d{4})/i.exec(message);
  if (match === null) return undefined;
  const code = Number(match[1]);
  return Number.isInteger(code) ? code : undefined;
}

/** Classify a failed Codex response without depending on pi-ai internals. */
export function classifyCodexFailure(input: {
  message: string;
  stopReason?: string;
  signal?: AbortSignal;
  cause?: unknown;
}): ModelProviderError {
  const normalized = input.message.toLowerCase();
  const transportCode = websocketCloseCode(input.message);
  const aborted = input.stopReason === "aborted"
    || input.signal?.aborted === true
    || (input.cause instanceof Error && input.cause.name === "AbortError");
  if (aborted) {
    return new ModelProviderError(input.message, {
      kind: "aborted",
      retryable: false,
      cause: input.cause,
    });
  }

  if (transportCode !== undefined && PERMANENT_WEBSOCKET_CLOSE_CODES.has(transportCode)) {
    return new ModelProviderError(input.message, {
      kind: "permanent",
      retryable: false,
      transportCode,
      cause: input.cause,
    });
  }
  if (
    normalized.includes("protocol error")
    || normalized.includes("policy violation")
    || normalized.includes("invalid data")
    || normalized.includes("invalid payload")
  ) {
    return new ModelProviderError(input.message, {
      kind: "permanent",
      retryable: false,
      ...(transportCode !== undefined ? { transportCode } : {}),
      cause: input.cause,
    });
  }

  const transientTransport = (transportCode !== undefined && TRANSIENT_WEBSOCKET_CLOSE_CODES.has(transportCode))
    || normalized.includes("websocket")
    || /(?:connection|connect|idle).*(?:timed out|timeout)/.test(normalized)
    || /(?:timed out|timeout).*(?:connection|connect|idle)/.test(normalized)
    || /premature.*(?:stream|clos)/.test(normalized)
    || /stream.*(?:premature|closed unexpectedly|ended unexpectedly)/.test(normalized);
  if (transientTransport) {
    return new ModelProviderError(input.message, {
      kind: "transport",
      retryable: true,
      ...(transportCode !== undefined ? { transportCode } : {}),
      cause: input.cause,
    });
  }

  const providerTransient = normalized.includes("server_error")
    || normalized.includes("service unavailable")
    || normalized.includes("temporarily unavailable")
    || normalized.includes("overloaded")
    || normalized.includes("rate limit")
    || normalized.includes("you can retry your request")
    || /\b(408|409|425|429|500|502|503|504)\b/.test(normalized);
  return new ModelProviderError(input.message, {
    kind: providerTransient ? "provider_transient" : "permanent",
    retryable: providerTransient,
    ...(transportCode !== undefined ? { transportCode } : {}),
    cause: input.cause,
  });
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rethrowClassifiedCodexFailure(error: unknown, signal?: AbortSignal): never {
  if (error instanceof ModelProviderError) throw error;
  const message = failureMessage(error);
  throw classifyCodexFailure({ message, signal, cause: error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (raw.trim() === "") return {};
  const parsed = JSON.parse(raw) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function textPart(text: string): TextContent {
  return { type: "text", text };
}

function imagePartFromUrl(part: OpenRouterImageUrlPart): ImageContent | TextContent {
  const url = part.image_url.url;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (match === null) {
    return textPart(`[image URL omitted for Codex backend: ${url}]`);
  }
  return {
    type: "image",
    mimeType: match[1] ?? "image/png",
    data: match[2] ?? "",
  };
}

function contentToText(content: OpenRouterMessage["content"]): string {
  if (content === null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((part): part is OpenRouterTextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function contentToUserBlocks(content: OpenRouterMessage["content"]): string | Array<TextContent | ImageContent> {
  if (content === null) return "";
  if (typeof content === "string") return content;
  const blocks = content.map((part) => part.type === "text" ? textPart(part.text) : imagePartFromUrl(part));
  return blocks.length === 1 && blocks[0]?.type === "text" ? blocks[0].text : blocks;
}

function toolCallsToBlocks(toolCalls: OpenRouterToolCall[] | undefined): PiToolCall[] {
  if (toolCalls === undefined) return [];
  return toolCalls.map((call) => ({
    type: "toolCall",
    id: call.id,
    name: call.function.name,
    arguments: parseToolArguments(call.function.arguments),
  }));
}

type PiAssistantContentBlock = TextContent | ThinkingContent | PiToolCall;

function nativeContentToPiBlocks(content: ProviderNativeAssistantContent[]): PiAssistantContentBlock[] {
  return content.map((block) => {
    if (block.type === "thinking") {
      return {
        type: "thinking",
        thinking: block.thinking,
        ...(block.thinkingSignature !== undefined ? { thinkingSignature: block.thinkingSignature } : {}),
      };
    }
    if (block.type === "text") {
      return {
        type: "text",
        text: block.text,
        ...(block.textSignature !== undefined ? { textSignature: block.textSignature } : {}),
      };
    }
    return {
      type: "toolCall",
      id: block.id,
      name: block.name,
      arguments: { ...block.arguments },
      ...(block.thoughtSignature !== undefined ? { thoughtSignature: block.thoughtSignature } : {}),
    };
  });
}

function messageToPiMessage(message: OpenRouterMessage, model: string): Message[] {
  const timestamp = Date.now();
  if (message.role === "user") {
    return [{ role: "user", content: contentToUserBlocks(message.content), timestamp }];
  }
  if (message.role === "assistant") {
    const text = contentToText(message.content).trim();
    const content = message.providerNativeContent !== undefined && message.providerNativeContent.length > 0
      ? nativeContentToPiBlocks(message.providerNativeContent)
      : [
        ...(text !== "" ? [textPart(text)] : []),
        ...toolCallsToBlocks(message.tool_calls),
      ];
    if (content.length === 0) return [];
    const hasToolCalls = content.some((block) => block.type === "toolCall");
    return [{
      role: "assistant",
      content,
      api: "openai-codex-responses",
      provider: "openai-codex",
      model,
      usage: zeroUsage(),
      stopReason: hasToolCalls ? "toolUse" : "stop",
      timestamp,
    }];
  }
  if (message.role === "tool") {
    const toolResult: ToolResultMessage = {
      role: "toolResult",
      toolCallId: message.tool_call_id ?? "",
      toolName: message.name ?? "tool",
      content: [textPart(contentToText(message.content))],
      details: {},
      isError: false,
      timestamp,
    };
    return toolResult.toolCallId !== "" ? [toolResult] : [];
  }
  return [];
}

function buildResponseFormatInstruction(responseFormat: Record<string, unknown> | undefined): string {
  if (responseFormat === undefined) return "";
  return [
    "Return only valid JSON for this turn. Do not wrap it in markdown.",
    "The caller requested this JSON response format:",
    JSON.stringify(responseFormat),
  ].join("\n");
}

/** Convert the bot's chat-completions request shape into pi-ai's Codex context shape. */
export function buildCodexContext(request: OpenRouterChatRequest): Context {
  const systemMessages: string[] = [];
  if (request.systemPrompt !== "") systemMessages.push(request.systemPrompt);
  const messages: Message[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      const text = contentToText(message.content).trim();
      if (text !== "") systemMessages.push(text);
      continue;
    }
    messages.push(...messageToPiMessage(message, request.model));
  }

  const responseFormatInstruction = buildResponseFormatInstruction(request.responseFormat);
  if (responseFormatInstruction !== "") systemMessages.push(responseFormatInstruction);

  const tools: Tool[] = (request.tools ?? []).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description ?? "",
    parameters: tool.function.parameters as Tool["parameters"],
  }));

  return {
    systemPrompt: systemMessages.join("\n\n"),
    messages,
    ...(tools.length > 0 && request.toolChoice !== "none" ? { tools } : {}),
  };
}

function resultText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function resultToolCalls(message: AssistantMessage): OpenRouterToolCall[] {
  return message.content
    .filter((block): block is PiToolCall => block.type === "toolCall")
    .map((block) => ({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: JSON.stringify(block.arguments),
      },
    }));
}

function resultProviderNativeContent(message: AssistantMessage): ProviderNativeAssistantContent[] {
  return message.content.map((block) => {
    if (block.type === "thinking") {
      return {
        type: "thinking",
        thinking: block.thinking,
        ...(block.thinkingSignature !== undefined ? { thinkingSignature: block.thinkingSignature } : {}),
      };
    }
    if (block.type === "text") {
      return {
        type: "text",
        text: block.text,
        ...(block.textSignature !== undefined ? { textSignature: block.textSignature } : {}),
      };
    }
    return {
      type: "toolCall",
      id: block.id,
      name: block.name,
      arguments: { ...block.arguments },
      ...(block.thoughtSignature !== undefined ? { thoughtSignature: block.thoughtSignature } : {}),
    };
  });
}

function usageForLogs(usage: Usage): Record<string, unknown> {
  return {
    input: usage.input + usage.cacheRead,
    output: usage.output,
    totalTokens: usage.totalTokens,
    ...(usage.cacheRead > 0 ? { cachedTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
    cost: usage.cost,
  };
}

function messageForLogs(message: AssistantMessage, text: string, toolCalls: OpenRouterToolCall[]): Record<string, unknown> {
  return {
    role: "assistant",
    model: message.model,
    stopReason: message.stopReason,
    content: text !== "" ? [{ type: "text", text }] : [],
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    usage: usageForLogs(message.usage),
    timestamp: message.timestamp,
    rawResponse: message,
  };
}

function codexAuthPath(request: OpenRouterChatRequest): string {
  const value = request.providerParams?.codexAuthPath;
  return typeof value === "string" && value !== "" ? value : DEFAULT_CODEX_AUTH_PATH;
}

function providerParamsWithoutInternalFields(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const result = { ...(params ?? {}) };
  delete result.codexAuthPath;
  delete result.apiKey;
  delete result.signal;
  delete result.onPayload;
  return result;
}

function applyPromptCacheKey(payload: unknown, promptCacheKey: string | undefined): void {
  if (promptCacheKey === undefined || !isRecord(payload)) return;
  if (promptCacheKey === "") {
    delete payload.prompt_cache_key;
    return;
  }
  payload.prompt_cache_key = promptCacheKey;
}

/** Complete a bot chat turn using ChatGPT subscription-backed OpenAI Codex. */
export async function completeCodexChat(request: OpenRouterChatRequest): Promise<OpenRouterChatResult> {
  const model = resolveModel(request.model, "openai-codex");
  const apiKey = request.apiKey !== "" ? request.apiKey : await getCodexApiKey(codexAuthPath(request));
  const context = buildCodexContext(request);
  const options = {
    apiKey,
    sessionId: request.sessionId,
    transport: "websocket-cached" as const,
    signal: request.signal,
    onPayload: (payload: unknown) => {
      applyPromptCacheKey(payload, request.promptCacheKey);
      request.onPayload?.(payload);
    },
    ...providerParamsWithoutInternalFields(request.providerParams),
  };
  if (request.onTextDelta !== undefined) {
    try {
      const eventStream = stream(model, context, options);
      for await (const event of eventStream) {
        if (event.type === "text_delta") {
          await request.onTextDelta(event.delta);
        }
      }
      const response = await eventStream.result();
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        const message = response.errorMessage ?? `OpenAI Codex request failed: ${response.stopReason}`;
        throw classifyCodexFailure({ message, stopReason: response.stopReason, signal: request.signal });
      }

      const text = resultText(response);
      const toolCalls = resultToolCalls(response);
      const providerNativeContent = resultProviderNativeContent(response);
      return {
        text,
        toolCalls,
        stopReason: response.stopReason,
        providerNativeContent,
        messageForLogs: messageForLogs(response, text, toolCalls),
        rawResponse: response as unknown as Record<string, unknown>,
      };
    } catch (error) {
      rethrowClassifiedCodexFailure(error, request.signal);
    }
  }

  try {
    const response = await complete(model, context, {
      ...options,
    });

    if (response.stopReason === "error" || response.stopReason === "aborted") {
      const message = response.errorMessage ?? `OpenAI Codex request failed: ${response.stopReason}`;
      throw classifyCodexFailure({ message, stopReason: response.stopReason, signal: request.signal });
    }

    const text = resultText(response);
    const toolCalls = resultToolCalls(response);
    const providerNativeContent = resultProviderNativeContent(response);
    return {
      text,
      toolCalls,
      stopReason: response.stopReason,
      providerNativeContent,
      messageForLogs: messageForLogs(response, text, toolCalls),
      rawResponse: response as unknown as Record<string, unknown>,
    };
  } catch (error) {
    rethrowClassifiedCodexFailure(error, request.signal);
  }
}
