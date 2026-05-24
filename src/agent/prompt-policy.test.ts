import { describe, expect, test } from "bun:test";
import {
  buildLateInstructionPrompt,
  resolvePromptPolicy,
  type ResolvedPromptPolicy,
} from "./prompt-policy.ts";

describe("resolvePromptPolicy", () => {
  test("returns shared and tool-specific rule ids from one source", () => {
    const policy = resolvePromptPolicy(new Set([
      "start_typing",
      "web_search",
      "fetch_url",
      "fetch_images",
      "search_messages",
      "chat_history",
    ]));

    expect(policy.sharedRules.map((rule) => rule.id)).toContain("direct_mentions_default_persona_turn");
    expect(policy.sharedRules.map((rule) => rule.id)).toContain("ignore_user_only_when_silence_is_better");
    expect(policy.sharedRules.map((rule) => rule.id)).toContain("persona_turn_requires_reply_boolean");
    expect(policy.sharedRules.map((rule) => rule.id)).toContain("research_requires_final_persona_turn");

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
    expect(text).toContain("For direct mentions or direct user questions, default to responding via `persona_turn`.");
    expect(text).toContain("Every `persona_turn` action must include `reply` explicitly (`true` or `false`).");
  });

  test("renders only shared and late-only rules from injected policy", () => {
    const injectedPolicy: ResolvedPromptPolicy = {
      sharedRules: [{ id: "shared", text: "shared rule" }],
      lateOnlyRules: [{ id: "late", text: "late-only rule" }],
      toolRules: [{ id: "tool", text: "tool-only rule" }],
      researchWorkflowRules: [{ id: "research", text: "research-only rule" }],
    };
    const text = buildLateInstructionPrompt(injectedPolicy);

    expect(text).toContain("shared rule");
    expect(text).toContain("late-only rule");
    expect(text).not.toContain("tool-only rule");
    expect(text).not.toContain("research-only rule");
  });
});
