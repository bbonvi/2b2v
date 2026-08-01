import { shouldCompact } from "@earendil-works/pi-agent-core";
import type { Logger, RequestLog } from "../logger.ts";
import type { LlmModel } from "../llm/client.ts";
import type { OpenRouterChatRequest, OpenRouterChatResult, OpenRouterMessage } from "../llm/types.ts";
import type { ChatCompleteFn } from "./turn-types.ts";

const SUMMARY_SYSTEM_PROMPT = "Summarize a private background-agent transcript for the same agent to continue. Do not continue the task.";

function messageText(message: OpenRouterMessage): string {
  const content = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
      : "";
  const calls = (message.tool_calls ?? []).map((call) => `${call.function.name}(${call.function.arguments})`);
  return [`[${message.role}${message.name !== undefined ? `:${message.name}` : ""}]`, content, ...calls]
    .filter((part) => part !== "")
    .join("\n");
}

export function estimateTranscriptTokens(messages: readonly OpenRouterMessage[]): number {
  return messages.reduce((tokens, message) => {
    const imageCount = Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "image_url").length
      : 0;
    return tokens + Math.ceil(messageText(message).length / 4) + imageCount * 8_192;
  }, 0);
}

function retainedTailStart(messages: readonly OpenRouterMessage[], keepRecentTokens: number): number {
  let tokens = 0;
  for (let index = messages.length - 1; index > 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    tokens += estimateTranscriptTokens([message]);
    if (tokens >= keepRecentTokens && (message.role === "user" || message.role === "assistant")) return index;
  }
  return 0;
}

/** Compact old completed rounds while preserving a safe recent user-turn boundary. */
export async function compactBackgroundTranscript(input: {
  messages: OpenRouterMessage[];
  fixedPromptTokens: number;
  model: LlmModel;
  reserveTokens: number;
  keepRecentTokens: number;
  complete: ChatCompleteFn;
  requestBase: Omit<OpenRouterChatRequest, "messages">;
  signal: AbortSignal;
  requestLog?: RequestLog;
  log?: Logger;
}): Promise<void> {
  const settings = {
    enabled: true,
    reserveTokens: input.reserveTokens,
    keepRecentTokens: input.keepRecentTokens,
  };
  const tokens = input.fixedPromptTokens + estimateTranscriptTokens(input.messages);
  if (!shouldCompact(tokens, input.model.contextWindow, settings)) return;
  const tailStart = retainedTailStart(input.messages, input.keepRecentTokens);
  if (tailStart === 0) return;
  const prefix = input.messages.slice(0, tailStart).map(messageText).join("\n\n");
  let result: OpenRouterChatResult;
  try {
    result = await input.complete({
      provider: input.requestBase.provider,
      apiKey: input.requestBase.apiKey,
      model: input.requestBase.model,
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      providerParams: input.requestBase.providerParams,
      messages: [{
        role: "user",
        content: [
          "Create a concise structured checkpoint with: Goal, Constraints, Completed Work, Current State, Key Decisions, Next Steps, and exact file paths/IDs needed to continue.",
          "Preserve concrete tool results and failures. Omit chatter and raw image data.",
          `<transcript>\n${prefix}\n</transcript>`,
        ].join("\n\n"),
      }],
      tools: [],
      toolChoice: "none",
      parallelToolCalls: false,
      signal: input.signal,
      onPayload: (payload) => input.requestLog?.recordLLMRequest(payload),
    });
  } catch (error) {
    if (input.signal.aborted) throw error;
    input.log?.warn("background agent transcript compaction failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  input.requestLog?.recordLLMCompletion(result.messageForLogs);
  const summary = result.text.trim();
  if (summary === "") return;
  input.messages.splice(0, tailStart, {
    role: "user",
    content: `## Background Agent Context Checkpoint\n${summary}`,
  });
  input.log?.info("background agent transcript compacted", {
    tokensBefore: tokens,
    retainedMessages: input.messages.length,
  });
}
