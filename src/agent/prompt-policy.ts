export interface PromptPolicyRule {
  id: string;
  text: string;
}

interface ToolScopedRule extends PromptPolicyRule {
  requiredTools: readonly string[];
}

export interface ResolvedPromptPolicy {
  sharedRules: PromptPolicyRule[];
  lateOnlyRules: PromptPolicyRule[];
  toolRules: PromptPolicyRule[];
  researchWorkflowRules: PromptPolicyRule[];
}

const SHARED_RULES: readonly PromptPolicyRule[] = [
  {
    id: "direct_mentions_default_send_message",
    text: "For direct mentions or direct user questions, default to responding via `send_message`.",
  },
  {
    id: "ignore_user_only_when_silence_is_better",
    text: "Use `ignore_user` only when silence is clearly better (spam, no actionable request, or explicit request to ignore).",
  },
  {
    id: "send_message_requires_reply_boolean",
    text: "Every `send_message` arguments object must include `reply` explicitly (`true` or `false`).",
  },
  {
    id: "uncertain_facts_require_web_search",
    text: "If the user asks for facts you are uncertain about, use `web_search` before answering.",
  },
  {
    id: "research_requires_final_send_message",
    text: "If you start research/tool work, always finish with at least one `send_message` unless `ignore_user` is explicitly justified.",
  },
];

const LATE_ONLY_RULES: readonly PromptPolicyRule[] = [
  {
    id: "follow_structured_json_protocol",
    text: "Follow the structured action JSON protocol exactly (no plain-text output outside JSON).",
  },
  {
    id: "user_visible_output_via_send_message_only",
    text: "User-visible output can only be sent through `send_message`.",
  },
  {
    id: "start_typing_before_send_message",
    text: "If you plan to send a reply, call `start_typing` before every `tool_call` until the final `send_message`.",
  },
  {
    id: "consider_all_tools_before_deciding",
    text: "Consider all available tools before deciding.",
  },
  {
    id: "recall_memories_when_relevant",
    text: "Recall user-related memories when relevant.",
  },
  {
    id: "search_literal_then_semantic",
    text: "For historical recall, try literal search first, then semantic fallback with alternate queries.",
  },
  {
    id: "maintain_journal_quality",
    text: "Proactively maintain journal quality (merge or delete stale entries).",
  },
  {
    id: "prioritize_channel_updates",
    text: "If you see [CHANNEL UPDATE] or follow-up annotations in tool results, prioritize same-user follow-ups and avoid repetition.",
  },
  {
    id: "use_reply_to_message_id_for_followups",
    text: "Use `reply_to_message_id` for specific follow-up replies.",
  },
];

const TOOL_RULES: readonly ToolScopedRule[] = [
  {
    id: "tool_web_search_discover_sources",
    text: "Use web_search to discover relevant sources for uncertain or current facts.",
    requiredTools: ["web_search"],
  },
  {
    id: "tool_fetch_url_extract_details",
    text: "Use fetch_url to open and extract details from specific URLs.",
    requiredTools: ["fetch_url"],
  },
  {
    id: "tool_web_search_requires_fetch_url",
    text: "If web_search is used, you must call fetch_url on at least one result before final factual answer.",
    requiredTools: ["web_search", "fetch_url"],
  },
  {
    id: "tool_search_messages_retrieve_older_context",
    text: "Use search_messages to retrieve older chat context.",
    requiredTools: ["search_messages"],
  },
  {
    id: "tool_chat_history_recent_context",
    text: "Use chat_history to inspect recent in-channel context before replying.",
    requiredTools: ["chat_history"],
  },
  {
    id: "tool_start_typing_refresh",
    text: "If you are planning to reply, call start_typing before every tool_call (including before send_message).",
    requiredTools: ["start_typing"],
  },
  {
    id: "tool_read_chat_images_for_stored_images",
    text: "Use read_chat_images with image_ids from chat history when inspecting stored images.",
    requiredTools: ["read_chat_images"],
  },
  {
    id: "tool_fetch_images_for_external_urls",
    text: "Use fetch_images for external image URLs that are not already in chat history.",
    requiredTools: ["fetch_images"],
  },
  {
    id: "tool_list_members_for_identity",
    text: "Use list_members for member identity or online/offline context requests.",
    requiredTools: ["list_members"],
  },
  {
    id: "tool_schedule_message_for_reminders",
    text: "Use schedule_message for reminders or delayed follow-ups with explicit timing details.",
    requiredTools: ["schedule_message"],
  },
  {
    id: "tool_start_thread_for_long_replies",
    text: "Use start_thread when the answer is long and would clutter the parent channel.",
    requiredTools: ["start_thread"],
  },
  {
    id: "tool_bash_progress_and_preview",
    text: "Before bash, send a short progress message and include a command preview.",
    requiredTools: ["bash"],
  },
  {
    id: "tool_recall_user_memories_for_other_users",
    text: "Use recall_user_memories(username) when you need memories for users other than the current message author.",
    requiredTools: ["recall_user_memories"],
  },
  {
    id: "tool_save_user_memory_for_durable_facts",
    text: "Use save_user_memory for durable facts about the current user in this conversation, not transient chatter.",
    requiredTools: ["save_user_memory"],
  },
  {
    id: "tool_recall_journal_before_save",
    text: "Use recall_journal_entry before creating new journal entries on related topics.",
    requiredTools: ["recall_journal_entry"],
  },
  {
    id: "tool_save_journal_for_durable_context",
    text: "Use save_journal_entry for durable multi-user context worth preserving.",
    requiredTools: ["save_journal_entry"],
  },
  {
    id: "tool_delete_memory_only_on_clear_request",
    text: "Use delete memory tools only when the user clearly requests removal or correction.",
    requiredTools: ["delete_journal_entries"],
  },
  {
    id: "tool_delete_user_memory_only_on_clear_request",
    text: "Use delete memory tools only when the user clearly requests removal or correction.",
    requiredTools: ["delete_user_memories"],
  },
];

const RESEARCH_WORKFLOW_RULES: readonly ToolScopedRule[] = [
  {
    id: "research_workflow_title",
    text: "Research workflow for uncertain factual requests:",
    requiredTools: ["web_search", "fetch_url"],
  },
  {
    id: "research_workflow_breadcrumb_updates",
    text: "Leave breadcrumb progress updates via send_message while researching.",
    requiredTools: ["web_search", "fetch_url"],
  },
  {
    id: "research_workflow_search_then_fetch",
    text: "Start with web_search, then use fetch_url on selected results before final factual answer.",
    requiredTools: ["web_search", "fetch_url"],
  },
  {
    id: "research_workflow_parallel_fetch",
    text: "Run multiple independent fetch_url calls for selected sources (parallel when possible).",
    requiredTools: ["web_search", "fetch_url"],
  },
  {
    id: "research_workflow_optional_images",
    text: "If images are relevant, use fetch_images on selected image URLs.",
    requiredTools: ["web_search", "fetch_url", "fetch_images"],
  },
  {
    id: "research_workflow_consolidate_and_reason",
    text: "Consolidate findings across sources, summarize evidence, then do one more reasoning pass before final answer.",
    requiredTools: ["web_search", "fetch_url"],
  },
];

function includeToolRule(
  rule: ToolScopedRule,
  toolNames: ReadonlySet<string>,
): boolean {
  return rule.requiredTools.every((tool) => toolNames.has(tool));
}

export function resolvePromptPolicy(
  toolNames: ReadonlySet<string>,
): ResolvedPromptPolicy {
  return {
    sharedRules: [...SHARED_RULES],
    lateOnlyRules: [...LATE_ONLY_RULES],
    toolRules: TOOL_RULES
      .filter((rule) => includeToolRule(rule, toolNames))
      .map((rule) => ({ id: rule.id, text: rule.text })),
    researchWorkflowRules: RESEARCH_WORKFLOW_RULES
      .filter((rule) => includeToolRule(rule, toolNames))
      .map((rule) => ({ id: rule.id, text: rule.text })),
  };
}

export function buildLateInstructionPrompt(
  resolved: Pick<ResolvedPromptPolicy, "sharedRules" | "lateOnlyRules"> = resolvePromptPolicy(new Set<string>()),
): string {
  const lines = [...resolved.sharedRules, ...resolved.lateOnlyRules]
    .map((rule) => `- ${rule.text}`);
  return ["CRITICAL:", ...lines].join("\n");
}
