import { completeCodexChat } from "./codex-chat.ts";
import { completeOpenRouterChat } from "./openrouter-chat.ts";
import type { OpenRouterChatRequest, OpenRouterChatResult } from "./types.ts";

/** Dispatch a chat request to the configured backend adapter. */
export async function completeLlmChat(request: OpenRouterChatRequest): Promise<OpenRouterChatResult> {
  return request.provider === "openai-codex"
    ? await completeCodexChat(request)
    : await completeOpenRouterChat(request);
}
