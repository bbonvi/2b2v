import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

export const MAX_DISCORD_TIMEOUT_SECONDS = 28 * 24 * 60 * 60;

const UNIT_TO_SECONDS: Record<TimeoutUnit, number> = {
  minutes: 60,
  hours: 60 * 60,
  days: 24 * 60 * 60,
};

const TimeoutUserParams = Type.Object({
  target: Type.String({
    minLength: 1,
    description: "Target Discord guild member as a username, @mention, or raw user ID.",
  }),
  duration: Type.Number({
    description: "Timeout duration amount.",
  }),
  unit: Type.Union(
    [Type.Literal("minutes"), Type.Literal("hours"), Type.Literal("days")],
    { description: "Duration unit." },
  ),
  reason: Type.Optional(Type.String({
    description: "Optional short reason for Discord's audit log.",
  })),
});

export type TimeoutUserInput = Static<typeof TimeoutUserParams>;
type TimeoutUnit = TimeoutUserInput["unit"];

const RemoveUserTimeoutParams = Type.Object({
  target: Type.String({
    minLength: 1,
    description: "Target Discord guild member as a username, @mention, or raw user ID.",
  }),
  reason: Type.Optional(Type.String({
    description: "Optional short reason for Discord's audit log.",
  })),
});

export type RemoveUserTimeoutInput = Static<typeof RemoveUserTimeoutParams>;

export interface TimeoutMember {
  id: string;
  username: string;
  displayName: string;
  isBot: boolean;
  moderatable?: boolean;
  timeout: (durationMs: number | null, reason?: string) => Promise<void>;
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

type TimeoutFailureResult = AgentToolResult<{ error: string }>;

type RemoveUserTimeoutResult = AgentToolResult<
  | { userId: string; removed: true }
  | { error: string }
>;

/** Create the constrained Discord timeout moderation tools for tiny guild use. */
export function createDiscordTimeoutTools(deps: TimeoutUserToolDeps): AgentTool[] {
  return [
    createDiscordSetUserTimeoutTool(deps),
    createDiscordRemoveUserTimeoutTool(deps),
  ];
}

/** Create the constrained Discord timeout setter tool. */
export function createDiscordSetUserTimeoutTool(deps: TimeoutUserToolDeps): AgentTool {
  return {
    name: "discord_set_user_timeout",
    label: "discord_set_user_timeout",
    description: "Temporarily time out one Discord guild member.",
    parameters: TimeoutUserParams,

    async execute(_toolCallId: string, params: unknown): Promise<TimeoutUserResult> {
      if (deps.guildId === undefined || deps.guildId.trim() === "") {
        return failure("discord_set_user_timeout only works in a Discord guild/server, not DMs.", "not_guild");
      }

      const adminFailure = await adminFailureResult(deps);
      if (adminFailure !== null) return adminFailure;

      const p = params as Partial<TimeoutUserInput>;
      const target = typeof p.target === "string" ? p.target.trim() : "";
      if (target === "") {
        return failure("Target username, mention, or user ID is required.", "missing_target");
      }

      const durationSeconds = parseDurationSeconds(p.duration, p.unit);
      if (typeof durationSeconds === "string") return failure(durationSeconds, "invalid_duration");

      const member = await resolveModerationTarget(deps, target);
      if (isFailure(member)) return member;

      const durationMs = durationSeconds * 1_000;
      const reason = cleanReason(p.reason);
      try {
        await member.timeout(durationMs, reason);
      } catch {
        return failure(
          `Failed to time out @${member.username}; the bot may lack Timeout Members permission, or Discord rejected the role hierarchy.`,
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

/** Create the constrained Discord timeout removal tool. */
export function createDiscordRemoveUserTimeoutTool(deps: TimeoutUserToolDeps): AgentTool {
  return {
    name: "discord_remove_user_timeout",
    label: "discord_remove_user_timeout",
    description: "Remove one Discord guild member timeout.",
    parameters: RemoveUserTimeoutParams,

    async execute(_toolCallId: string, params: unknown): Promise<RemoveUserTimeoutResult> {
      if (deps.guildId === undefined || deps.guildId.trim() === "") {
        return failure("discord_remove_user_timeout only works in a Discord guild/server, not DMs.", "not_guild");
      }

      const adminFailure = await adminFailureResult(deps);
      if (adminFailure !== null) return adminFailure;

      const p = params as Partial<RemoveUserTimeoutInput>;
      const target = typeof p.target === "string" ? p.target.trim() : "";
      if (target === "") {
        return failure("Target username, mention, or user ID is required.", "missing_target");
      }

      const member = await resolveModerationTarget(deps, target);
      if (isFailure(member)) return member;

      const reason = cleanReason(p.reason);
      try {
        await member.timeout(null, reason);
      } catch {
        return failure(
          `Failed to remove @${member.username}'s timeout; the bot may lack Timeout Members permission, or Discord rejected the role hierarchy.`,
          "remove_timeout_failed",
        );
      }

      const reasonText = reason !== undefined ? ` Reason: ${reason}` : "";
      return {
        content: [{
          type: "text",
          text: `Removed timeout from @${member.username} (${member.displayName}).${reasonText}`,
        }],
        details: {
          userId: member.id,
          removed: true,
        },
      };
    },
  };
}

async function adminFailureResult(deps: TimeoutUserToolDeps): Promise<TimeoutFailureResult | null> {
  let requesterAdmin: boolean;
  try {
    requesterAdmin = await deps.isRequesterAdmin();
  } catch {
    requesterAdmin = false;
  }
  if (requesterAdmin) return null;
  return failure(
    "Refusing to change a timeout unless the requesting Discord user is an admin.",
    "requester_not_admin",
  );
}

async function resolveModerationTarget(
  deps: TimeoutUserToolDeps,
  target: string,
): Promise<TimeoutMember | TimeoutFailureResult> {
  let member: TimeoutMemberResolution;
  try {
    member = await deps.resolveMember(target);
  } catch {
    return failure("Unable to resolve that guild member; the bot may lack permission to view members.", "resolve_failed");
  }

  if (member === null) {
    return failure(`No guild member found for '${target}'.`, "target_not_found");
  }
  if (isResolveError(member)) {
    return failure(member.message, member.error);
  }

  if (member.id === deps.botUserId) {
    return failure("Refusing to change the bot's own timeout.", "target_is_bot");
  }

  if (deps.guildOwnerId !== undefined && member.id === deps.guildOwnerId) {
    return failure("Refusing to change the guild owner's timeout.", "target_is_guild_owner");
  }

  if (member.moderatable === false) {
    return failure(
      `Cannot change timeout for @${member.username}; the bot may lack Timeout Members permission, or the target may be above the bot in the role hierarchy.`,
      "not_moderatable",
    );
  }

  return member;
}

function isFailure(value: TimeoutMember | TimeoutFailureResult): value is TimeoutFailureResult {
  return "content" in value && "details" in value;
}

function isResolveError(value: TimeoutMemberResolution): value is TimeoutMemberResolveError {
  return value !== null && "message" in value && "error" in value && !("timeout" in value);
}

function parseDurationSeconds(duration: unknown, unit: unknown): number | string {
  if (typeof duration !== "number" || !Number.isFinite(duration)) {
    return "Duration must be a finite number.";
  }
  if (unit !== "minutes" && unit !== "hours" && unit !== "days") {
    return "Duration unit must be minutes, hours, or days.";
  }

  const seconds = duration * UNIT_TO_SECONDS[unit];
  if (seconds <= 0) {
    return "Duration must be positive.";
  }
  if (seconds > MAX_DISCORD_TIMEOUT_SECONDS) {
    return "Duration cannot exceed 28 days.";
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
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = seconds / 60;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function failure(message: string, error: string): TimeoutFailureResult {
  return {
    content: [{ type: "text", text: message }],
    details: { error },
  };
}
