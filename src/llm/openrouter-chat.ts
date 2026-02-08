export interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterChatRequest {
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: OpenRouterMessage[];
  providerParams?: Record<string, unknown>;
  responseFormat?: Record<string, unknown>;
  signal?: AbortSignal;
  onPayload?: (payload: unknown) => void;
  baseUrl?: string;
}

export interface OpenRouterChatResult {
  text: string;
  messageForLogs: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function normalizeMessageContent(content: unknown): string {
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
): Record<string, unknown> {
  return {
    role: "assistant",
    model: typeof raw.model === "string" ? raw.model : modelId,
    stopReason: mapStopReason(finishReason),
    content: text !== "" ? [{ type: "text", text }] : [],
    usage: buildUsage(asRecord(raw.usage)),
    timestamp: Date.now(),
    rawResponse: raw,
  };
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

export async function completeOpenRouterChat(request: OpenRouterChatRequest): Promise<OpenRouterChatResult> {
  const providerParams = normalizeProviderParams(request.providerParams ?? {});
  const payload: Record<string, unknown> = {
    ...providerParams,
    model: request.model,
    messages: [
      { role: "system", content: request.systemPrompt },
      ...request.messages,
    ],
    stream: false,
  };

  if (request.responseFormat !== undefined) {
    payload.response_format = request.responseFormat;
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

  const raw = await response.json().catch(() => null);
  const rawRecord = asRecord(raw);

  if (!response.ok) {
    let message = `OpenRouter request failed: ${response.status}`;
    const errorRecord = asRecord(rawRecord?.error);
    if (typeof errorRecord?.message === "string" && errorRecord.message !== "") {
      message = errorRecord.message;
    }
    throw new Error(message);
  }

  if (rawRecord === null) {
    throw new Error("OpenRouter response was not JSON");
  }

  const choices = rawRecord.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("OpenRouter response missing choices");
  }

  const firstChoice = asRecord(choices[0]);
  const firstMessage = asRecord(firstChoice?.message);
  const content = firstMessage?.content;
  const text = normalizeMessageContent(content);
  const finishReason = firstChoice?.finish_reason;

  return {
    text,
    messageForLogs: normalizeAssistantPayload(rawRecord, request.model, text, finishReason),
    rawResponse: rawRecord,
  };
}
