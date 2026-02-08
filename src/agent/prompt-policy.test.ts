import { describe, expect, test } from "bun:test";
import {
  buildLateInstructionPrompt,
  resolvePromptPolicy,
} from "./prompt-policy.ts";

describe("resolvePromptPolicy", () => {
  test("returns shared and tool-specific rule ids from one source", () => {
    const policy = resolvePromptPolicy(new Set([
      "send_message",
      "start_typing",
      "web_search",
      "fetch_url",
      "fetch_images",
      "search_messages",
      "chat_history",
    ]));

    expect(policy.sharedRules.map((rule) => rule.id)).toContain("direct_mentions_default_send_message");
    expect(policy.sharedRules.map((rule) => rule.id)).toContain("ignore_user_only_when_silence_is_better");
    expect(policy.sharedRules.map((rule) => rule.id)).toContain("send_message_requires_reply_boolean");
    expect(policy.sharedRules.map((rule) => rule.id)).toContain("research_requires_final_send_message");

    expect(policy.toolRules.map((rule) => rule.id)).toContain("tool_web_search_discover_sources");
    expect(policy.toolRules.map((rule) => rule.id)).toContain("tool_fetch_url_extract_details");
    expect(policy.toolRules.map((rule) => rule.id)).toContain("tool_web_search_requires_fetch_url");
    expect(policy.toolRules.map((rule) => rule.id)).toContain("tool_search_messages_retrieve_older_context");
    expect(policy.toolRules.map((rule) => rule.id)).toContain("tool_chat_history_recent_context");
  });
});

describe("buildLateInstructionPrompt", () => {
  test("renders CRITICAL bullet list from shared policy rules", () => {
    const text = buildLateInstructionPrompt();
    expect(text).toContain("CRITICAL:");
    expect(text).toContain("For direct mentions or direct user questions, default to responding via `send_message`.");
    expect(text).toContain("Every `send_message` arguments object must include `reply` explicitly (`true` or `false`).");
  });
});
