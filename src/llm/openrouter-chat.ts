export interface OpenRouterTextPart {
  type: "text";
  text: string;
}

export interface OpenRouterImageUrlPart {
  type: "image_url";
  image_url: { url: string };
}

export type OpenRouterMessageContent = string | Array<OpenRouterTextPart | OpenRouterImageUrlPart> | null;

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: OpenRouterMessageContent;
  tool_call_id?: string;
  name?: string;
  tool_calls?: OpenRouterToolCall[];
}

export interface OpenRouterToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenRouterChatRequest {
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: OpenRouterMessage[];
  providerParams?: Record<string, unknown>;
  responseFormat?: Record<string, unknown>;
  tools?: OpenRouterToolDefinition[];
  toolChoice?: "auto" | "none";
  parallelToolCalls?: boolean;
  signal?: AbortSignal;
  onPayload?: (payload: unknown) => void;
  baseUrl?: string;
}

export interface OpenRouterChatResult {
  text: string;
  toolCalls: OpenRouterToolCall[];
  messageForLogs: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function normalizeMessageContent(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const textParts: string[] = [];
  for (const part of content) {
    const rec = asRecord(part);
    if (rec === null) continue;
    if (rec.type === "text" && typeof rec.text === "string") {
      textParts.push(rec.text);
    }
  }
  return textParts.join("\n");
}

function mapStopReason(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  if (value === "stop" || value === "length") return value;
  if (value === "tool_calls") return "toolUse";
  return value;
}

function buildUsage(rawUsage: Record<string, unknown> | null): Record<string, unknown> {
  if (rawUsage === null) {
    return {
      input: 0,
      output: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }

  const input = typeof rawUsage.prompt_tokens === "number" ? rawUsage.prompt_tokens : 0;
  const output = typeof rawUsage.completion_tokens === "number" ? rawUsage.completion_tokens : 0;
  const totalTokens = typeof rawUsage.total_tokens === "number" ? rawUsage.total_tokens : input + output;
  const rawCost = rawUsage.cost;
  const cost = asRecord(rawCost);
  const totalCost = typeof rawCost === "number"
    ? rawCost
    : typeof cost?.total === "number"
      ? cost.total
      : 0;

  return {
    input,
    output,
    totalTokens,
    cost: {
      input: typeof cost?.input === "number" ? cost.input : 0,
      output: typeof cost?.output === "number" ? cost.output : 0,
      cacheRead: typeof cost?.cache_read === "number" ? cost.cache_read : 0,
      cacheWrite: typeof cost?.cache_write === "number" ? cost.cache_write : 0,
      total: totalCost,
    },
  };
}

function normalizeAssistantPayload(
  raw: Record<string, unknown>,
  modelId: string,
  text: string,
  finishReason: unknown,
  toolCalls: OpenRouterToolCall[],
): Record<string, unknown> {
  return {
    role: "assistant",
    model: typeof raw.model === "string" ? raw.model : modelId,
    stopReason: mapStopReason(finishReason),
    content: text !== "" ? [{ type: "text", text }] : [],
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    usage: buildUsage(asRecord(raw.usage)),
    timestamp: Date.now(),
    rawResponse: raw,
  };
}

function normalizeToolCalls(value: unknown): OpenRouterToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: OpenRouterToolCall[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    const fn = asRecord(rec?.function);
    if (rec === null || fn === null) continue;
    if (typeof rec.id !== "string" || rec.id === "") continue;
    if (rec.type !== "function") continue;
    if (typeof fn.name !== "string" || fn.name === "") continue;
    const args = typeof fn.arguments === "string" ? fn.arguments : "{}";
    calls.push({
      id: rec.id,
      type: "function",
      function: {
        name: fn.name,
        arguments: args,
      },
    });
  }
  return calls;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function normalizeProviderOptions(provider: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(provider)) {
    switch (key) {
      case "allowFallbacks":
        normalized.allow_fallbacks = value;
        break;
      case "requireParameters":
        normalized.require_parameters = value;
        break;
      case "dataCollection":
        normalized.data_collection = value;
        break;
      case "maxPrice":
        normalized.max_price = value;
        break;
      case "enforceDistillableText":
        normalized.enforce_distillable_text = value;
        break;
      default:
        normalized[key] = value;
        break;
    }
  }
  return normalized;
}

function normalizeProviderParams(rawParams: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = { ...rawParams };
  const routeValue = params.route;
  const route = asRecord(routeValue);

  let provider = asRecord(params.provider);
  if (provider !== null) {
    provider = { ...provider };
  }

  // Legacy compatibility: old runtime forwarded `route` options directly.
  // OpenRouter fetch API expects provider routing controls under `provider`.
  if (route !== null) {
    provider ??= {};

    if (provider.sort === undefined && route.sort !== undefined) {
      provider.sort = route.sort;
    }

    const hasAllowFallbacks = provider.allow_fallbacks !== undefined || provider.allowFallbacks !== undefined;
    if (!hasAllowFallbacks && typeof route.fallback === "boolean") {
      provider.allow_fallbacks = route.fallback;
    }
  }

  if (routeValue !== undefined) {
    delete params.route;
  }

  if (provider !== null) {
    const normalizedProvider = normalizeProviderOptions(provider);
    if (Object.keys(normalizedProvider).length > 0) {
      params.provider = normalizedProvider;
    } else {
      delete params.provider;
    }
  }

  return params;
}

function extractNestedProviderErrorMessage(rawRecord: Record<string, unknown> | null): string | null {
  const errorRecord = asRecord(rawRecord?.error);
  const metadataRecord = asRecord(errorRecord?.metadata);
  if (metadataRecord === null) return null;

  const rawMetadata = metadataRecord.raw;
  if (typeof rawMetadata !== "string" || rawMetadata === "") return null;

  try {
    const parsed = asRecord(JSON.parse(rawMetadata) as unknown);
    const nestedError = asRecord(parsed?.error);
    if (typeof nestedError?.message === "string" && nestedError.message !== "") {
      return nestedError.message;
    }
  } catch {
    return null;
  }
  return null;
}

function extractOpenRouterErrorMessage(
  rawRecord: Record<string, unknown> | null,
  fallbackMessage: string,
): string {
  const errorRecord = asRecord(rawRecord?.error);
  let message = fallbackMessage;
  if (typeof errorRecord?.message === "string" && errorRecord.message !== "") {
    message = errorRecord.message;
  }

  const nestedProviderMessage = extractNestedProviderErrorMessage(rawRecord);
  if (nestedProviderMessage !== null && !message.includes(nestedProviderMessage)) {
    message = `${message}: ${nestedProviderMessage}`;
  }
  return message;
}

function appendRawResponse(message: string, rawRecord: Record<string, unknown> | null): string {
  if (rawRecord === null) return message;
  return `${message}; rawResponse=${JSON.stringify(rawRecord)}`;
}

export async function completeOpenRouterChat(request: OpenRouterChatRequest): Promise<OpenRouterChatResult> {
  const providerParams = normalizeProviderParams(request.providerParams ?? {});
  const payload: Record<string, unknown> = {
    ...providerParams,
    model: request.model,
    messages: [
      ...(request.systemPrompt !== "" ? [{ role: "system", content: request.systemPrompt }] : []),
      ...request.messages,
    ],
    stream: false,
  };

  if (request.responseFormat !== undefined) {
    payload.response_format = request.responseFormat;
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    payload.tools = request.tools;
    payload.tool_choice = request.toolChoice ?? "auto";
    payload.parallel_tool_calls = request.parallelToolCalls ?? true;
  }

  request.onPayload?.(payload);

  const base = normalizeBaseUrl(request.baseUrl ?? DEFAULT_BASE_URL);
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: request.signal,
  });

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    if (request.signal?.aborted === true) {
      const reason: unknown = request.signal.reason;
      throw reason instanceof Error ? reason : new Error("OpenRouter request aborted");
    }
    raw = null;
  }
  const rawRecord = asRecord(raw);

  if (!response.ok) {
    throw new Error(
      appendRawResponse(
        extractOpenRouterErrorMessage(rawRecord, `OpenRouter request failed: ${response.status}`),
        rawRecord,
      ),
    );
  }

  if (rawRecord === null) {
    throw new Error("OpenRouter response was not JSON");
  }

  if (asRecord(rawRecord.error) !== null) {
    throw new Error(
      appendRawResponse(
        extractOpenRouterErrorMessage(rawRecord, "OpenRouter returned error payload"),
        rawRecord,
      ),
    );
  }

  const choices = rawRecord.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(appendRawResponse("OpenRouter response missing choices", rawRecord));
  }

  const firstChoice = asRecord(choices[0]);
  const firstMessage = asRecord(firstChoice?.message);
  const content = firstMessage?.content;
  const text = normalizeMessageContent(content);
  const toolCalls = normalizeToolCalls(firstMessage?.tool_calls);
  const finishReason = firstChoice?.finish_reason;

  return {
    text,
    toolCalls,
    messageForLogs: normalizeAssistantPayload(rawRecord, request.model, text, finishReason, toolCalls),
    rawResponse: rawRecord,
  };
}
