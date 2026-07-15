import type { LlmProvider } from "../config/types.ts";

export interface OpenRouterTextPart {
  type: "text";
  text: string;
}

export interface OpenRouterImageUrlPart {
  type: "image_url";
  image_url: { url: string };
}

export type OpenRouterMessageContent = string | Array<OpenRouterTextPart | OpenRouterImageUrlPart> | null;

export interface ProviderNativeThinkingPart {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}

export interface ProviderNativeTextPart {
  type: "text";
  text: string;
  textSignature?: string;
}

export interface ProviderNativeToolCallPart {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}

export type ProviderNativeAssistantContent =
  | ProviderNativeThinkingPart
  | ProviderNativeTextPart
  | ProviderNativeToolCallPart;

export interface OpenRouterMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: OpenRouterMessageContent;
  tool_call_id?: string;
  name?: string;
  tool_calls?: OpenRouterToolCall[];
  /** Internal provider-native assistant blocks for stateless continuation; never sent to OpenRouter. */
  providerNativeContent?: ProviderNativeAssistantContent[];
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
  provider?: LlmProvider;
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: OpenRouterMessage[];
  providerParams?: Record<string, unknown>;
  /** OpenRouter sticky routing key for keeping prompt caches warm across turns. */
  sessionId?: string;
  responseFormat?: Record<string, unknown>;
  tools?: OpenRouterToolDefinition[];
  toolChoice?: "auto" | "none";
  parallelToolCalls?: boolean;
  signal?: AbortSignal;
  onPayload?: (payload: unknown) => void;
  onTextDelta?: (delta: string) => void | Promise<void>;
  baseUrl?: string;
}

export interface OpenRouterChatResult {
  text: string;
  toolCalls: OpenRouterToolCall[];
  /** Normalized terminal reason used to decide whether output is complete enough to deliver. */
  stopReason?: string;
  /** Internal provider-native assistant blocks for same-loop continuation. */
  providerNativeContent?: ProviderNativeAssistantContent[];
  messageForLogs: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
}
