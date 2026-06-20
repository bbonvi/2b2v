import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

export const MAX_TIMEOUT_SECONDS = 10 * 60;

const TimeoutUserParams = Type.Object({
  target: Type.String({
    minLength: 1,
    description: "Target Discord guild member as a username, @mention, or raw user ID.",
  }),
  duration: Type.Number({
    description: "Timeout duration amount. Must be positive and no more than 10 minutes after unit conversion.",
  }),
  unit: Type.Union(
    [Type.Literal("seconds"), Type.Literal("minutes")],
    { description: "Duration unit. Only seconds and minutes are supported." },
  ),
  reason: Type.Optional(Type.String({
    description: "Optional short reason for Discord's audit log.",
  })),
});

export type TimeoutUserInput = Static<typeof TimeoutUserParams>;

export interface TimeoutMember {
  id: string;
  username: string;
  displayName: string;
  isBot: boolean;
  moderatable?: boolean;
  timeout: (durationMs: number, reason?: string) => Promise<void>;
}

export interface TimeoutMemberResolveError {
  error: string;
  message: string;
}

export type TimeoutMemberResolution = TimeoutMember | TimeoutMemberResolveError | null;

export interface TimeoutUserToolDeps {
  guildId?: string;
  botUserId: string;
  guildOwnerId?: string;
  isRequesterAdmin: () => Promise<boolean>;
  resolveMember: (target: string) => Promise<TimeoutMemberResolution>;
}

type TimeoutUserResult = AgentToolResult<
  | { userId: string; durationSeconds: number; until: number }
  | { error: string }
>;

/** Create the constrained Discord timeout moderation tool for tiny guild use. */
export function createTimeoutUserTool(deps: TimeoutUserToolDeps): AgentTool {
  return {
    name: "timeout_user",
    label: "timeout_user",
    description:
      "Temporarily time out one Discord guild member using Discord communication-disabled-until/member timeout. 2B should almost never use this tool. Use it only when a channel/server admin explicitly asks her to time someone out. If admin status is not already clear, she can check admin status via list_chat_users before using this. Runtime rejects DMs, self-timeouts, guild-owner timeouts when known, non-positive durations, and durations over 10 minutes.",
    parameters: TimeoutUserParams,

    async execute(_toolCallId: string, params: unknown): Promise<TimeoutUserResult> {
      if (deps.guildId === undefined || deps.guildId.trim() === "") {
        return failure("timeout_user only works in a Discord guild/server, not DMs.", "not_guild");
      }

      let requesterAdmin: boolean;
      try {
        requesterAdmin = await deps.isRequesterAdmin();
      } catch {
        requesterAdmin = false;
      }
      if (!requesterAdmin) {
        return failure(
          "Refusing to time out a user unless the requesting Discord user is an admin.",
          "requester_not_admin",
        );
      }

      const p = params as Partial<TimeoutUserInput>;
      const target = typeof p.target === "string" ? p.target.trim() : "";
      if (target === "") {
        return failure("Target username, mention, or user ID is required.", "missing_target");
      }

      const durationSeconds = parseDurationSeconds(p.duration, p.unit);
      if (typeof durationSeconds === "string") return failure(durationSeconds, "invalid_duration");

      let member: TimeoutMember | null;
      try {
        member = await deps.resolveMember(target);
      } catch {
        return failure("Unable to resolve that guild member. The bot may lack permission to view members.", "resolve_failed");
      }

      if (member === null) {
        return failure(`No guild member found for '${target}'.`, "target_not_found");
      }
      if (isResolveError(member)) {
        return failure(member.message, member.error);
      }

      if (member.id === deps.botUserId) {
        return failure("Refusing to time out the bot itself.", "target_is_bot");
      }

      if (deps.guildOwnerId !== undefined && member.id === deps.guildOwnerId) {
        return failure("Refusing to time out the guild owner.", "target_is_guild_owner");
      }

      if (member.moderatable === false) {
        return failure(
          `Cannot time out @${member.username}. The bot may lack Timeout Members permission, or the target may be above the bot in the role hierarchy.`,
          "not_moderatable",
        );
      }

      const durationMs = durationSeconds * 1_000;
      const reason = cleanReason(p.reason);
      try {
        await member.timeout(durationMs, reason);
      } catch {
        return failure(
          `Failed to time out @${member.username}. The bot may lack Timeout Members permission, or Discord rejected the role hierarchy.`,
          "timeout_failed",
        );
      }

      const until = Date.now() + durationMs;
      const reasonText = reason !== undefined ? ` Reason: ${reason}` : "";
      return {
        content: [{
          type: "text",
          text: `Timed out @${member.username} (${member.displayName}) for ${formatDuration(durationSeconds)}.${reasonText}`,
        }],
        details: {
          userId: member.id,
          durationSeconds,
          until,
        },
      };
    },
  };
}

function isResolveError(value: TimeoutMemberResolution): value is TimeoutMemberResolveError {
  return value !== null && "message" in value && "error" in value && !("timeout" in value);
}

function parseDurationSeconds(duration: unknown, unit: unknown): number | string {
  if (typeof duration !== "number" || !Number.isFinite(duration)) {
    return "Duration must be a finite number.";
  }
  if (unit !== "seconds" && unit !== "minutes") {
    return "Duration unit must be seconds or minutes.";
  }

  const seconds = unit === "minutes" ? duration * 60 : duration;
  if (seconds <= 0) {
    return "Duration must be positive.";
  }
  if (seconds > MAX_TIMEOUT_SECONDS) {
    return "Duration cannot exceed 10 minutes.";
  }
  return seconds;
}

function cleanReason(reason: unknown): string | undefined {
  if (typeof reason !== "string") return undefined;
  const trimmed = reason.trim();
  if (trimmed === "") return undefined;
  return trimmed.slice(0, 512);
}

function formatDuration(seconds: number): string {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function failure(message: string, error: string): TimeoutUserResult {
  return {
    content: [{ type: "text", text: message }],
    details: { error },
  };
}
