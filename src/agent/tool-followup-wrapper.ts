import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Database } from "../db/database";
import { getFollowUpMessages, type FollowUpMessage } from "../db/followup-repository";

/** Tracks which follow-up messages have been surfaced to the agent. */
export interface FollowUpState {
  /** Message IDs already surfaced in tool results or transformContext. */
  surfacedIds: Set<string>;
  /** Same-user follow-up IDs that should be suppressed from replay runs. */
  coveredIds: Set<string>;
  /** Message IDs of bot sends in this handler run (excluded from queries). */
  botSendIds: Set<string>;
  /** Track a bot send ID (call when send_message completes). */
  registerBotSend(messageId: string): void;
}

export interface FollowUpWrapperDeps {
  db: Database;
  channelId: string;
  /** Epoch ms when the handler started processing. */
  handlerStartTime: number;
  botUserId: string;
  /** The trigger message ID (excluded from follow-up queries). */
  triggerMessageId: string;
  /** Triggering user ID for same-user follow-up scoping. */
  triggerUserId: string;
  /** Max follow-ups to surface per check. */
  maxFollowUps: number;
  /** Shared set of already-surfaced message IDs (e.g. from transformContext). */
  sharedSurfacedIds?: Set<string>;
  /** Shared set of same-user covered message IDs (for dispatcher suppression). */
  sharedCoveredIds?: Set<string>;
}

/**
 * Format a relative timestamp like "3s ago", "1m ago".
 */
function formatAgo(nowMs: number, thenMs: number): string {
  const diffMs = nowMs - thenMs;
  if (diffMs < 1000) return "just now";
  const secs = Math.round(diffMs / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  return `${mins}m ago`;
}

/**
 * Build detailed follow-up annotation for send_message tool results.
 */
function formatDetailedAnnotation(messages: FollowUpMessage[], nowMs: number): string {
  const lines = messages.map(
    (m) => `• ${m.authorUsername} [MsgID: ${m.id}] (${formatAgo(nowMs, m.createdAt)}): "${m.content}"`,
  );
  return [
    "---",
    "[FOLLOW-UP ACTIVITY since you started responding]",
    ...lines,
    "Address same-user follow-ups if relevant. Do not repeat what you already said.",
    "Use reply_to_message_id to reply to a specific message.",
    "---",
  ].join("\n");
}

/**
 * Build lightweight follow-up annotation.
 */
function formatLightweightAnnotation(
  triggerUserCount: number,
  otherUserCount: number,
): string {
  const parts: string[] = [];
  if (triggerUserCount > 0) {
    const plural = triggerUserCount === 1 ? "" : "s";
    parts.push(
      `Trigger user: ${triggerUserCount} new follow-up message${plural}. Use \`chat_history\` and \`reply_to_message_id\` if relevant.`,
    );
  }
  if (otherUserCount > 0) {
    const plural = otherUserCount === 1 ? "" : "s";
    parts.push(
      `Other users: ${otherUserCount} new message${plural}. FYI only, these remain queued for separate handling.`,
    );
  }
  if (parts.length === 0) return "";
  return ["---", ...parts, "---"].join("\n");
}

/**
 * Build send_message annotation with actionable same-user follow-ups and
 * informational other-user activity.
 */
function formatSendMessageAnnotation(
  sameUserFollowUps: FollowUpMessage[],
  otherUserFollowUps: FollowUpMessage[],
  nowMs: number,
): string {
  const blocks: string[] = [];
  if (sameUserFollowUps.length > 0) {
    blocks.push(formatDetailedAnnotation(sameUserFollowUps, nowMs));
  }
  if (otherUserFollowUps.length > 0) {
    const plural = otherUserFollowUps.length === 1 ? "" : "s";
    blocks.push([
      "---",
      "[OTHER USER ACTIVITY while you were responding]",
      `${otherUserFollowUps.length} new message${plural} from other users.`,
      "FYI only, these users are queued for separate handling.",
      "---",
    ].join("\n"));
  }
  return blocks.join("\n");
}

/**
 * Wrap tools to append follow-up message annotations to tool results.
 *
 * After each tool execution, queries SQLite for new messages in the channel.
 * For send_message, appends detailed annotation with message content.
 * For other tools, appends a lightweight count notification.
 *
 * Applied AFTER wrapToolsWithTiming in the pipeline:
 * tools -> wrapToolsWithTiming -> wrapToolsWithFollowUp -> structured action loop
 */
export function wrapToolsWithFollowUp(
  tools: AgentTool[],
  deps: FollowUpWrapperDeps,
): { tools: AgentTool[]; state: FollowUpState } {
  const surfacedIds = deps.sharedSurfacedIds ?? new Set<string>();
  const coveredIds = deps.sharedCoveredIds ?? new Set<string>();
  const botSendIds = new Set<string>();

  const state: FollowUpState = {
    surfacedIds,
    coveredIds,
    botSendIds,
    registerBotSend(messageId: string) {
      botSendIds.add(messageId);
    },
  };

  const wrappedTools = tools.map((tool) => ({
    ...tool,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
    ): Promise<AgentToolResult<unknown>> => {
      const result = await tool.execute(toolCallId, params, signal);

      // Track bot sends from send_message results
      if (tool.name === "send_message") {
        const details = result.details as { sentMessageId?: string } | undefined;
        if (details?.sentMessageId !== undefined && details.sentMessageId !== "") {
          botSendIds.add(details.sentMessageId);
        }
      }

      // Query for follow-up messages
      const excludeIds = new Set([...surfacedIds, ...botSendIds, deps.triggerMessageId]);
      const followUps = getFollowUpMessages(
        deps.db,
        deps.channelId,
        deps.handlerStartTime,
        excludeIds,
        deps.botUserId,
        deps.maxFollowUps,
      );

      if (followUps.length === 0) {
        return result;
      }

      const userFollowUps = followUps.filter((m) => !m.isBot);
      if (userFollowUps.length === 0) {
        return result;
      }

      const sameUserFollowUps = userFollowUps.filter((m) => m.userId === deps.triggerUserId);
      const otherUserFollowUps = userFollowUps.filter((m) => m.userId !== deps.triggerUserId);

      // Mark surfaced for de-duplication within this run.
      for (const msg of userFollowUps) {
        surfacedIds.add(msg.id);
      }
      // Mark covered only for same-user actionable follow-ups.
      for (const msg of sameUserFollowUps) {
        coveredIds.add(msg.id);
      }

      // Build annotation based on tool type
      const nowMs = Date.now();
      const annotation = tool.name === "send_message"
        ? formatSendMessageAnnotation(sameUserFollowUps, otherUserFollowUps, nowMs)
        : formatLightweightAnnotation(sameUserFollowUps.length, otherUserFollowUps.length);
      if (annotation === "") {
        return result;
      }

      return {
        ...result,
        content: [...result.content, { type: "text", text: `\n${annotation}` }],
      };
    },
  }));

  return { tools: wrappedTools, state };
}
