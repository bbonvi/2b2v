import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { CronPattern } from "croner";
import type { Database } from "../db/database";
import {
  createSchedule,
  deletePendingSchedule,
  listPendingSchedules,
  type ScheduleRow,
} from "../db/schedule-repository";
import { formatLocalWallClock, parseLocalDateTimeToEpoch } from "../time/agent-time.ts";

export interface ScheduleToolDeps {
  db: Database;
  guildId: string;
  channelId: string;
  timezone: string;
  /** Called after schedule is created so the engine can register it at runtime. */
  onScheduleCreated?: (scheduleId: string) => void;
  /** Called after schedule is deleted so the engine can unregister it at runtime. */
  onScheduleDeleted?: (scheduleId: string) => void;
}

const UNIT_TO_MS: Record<string, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
};

const ScheduleMessageParams = Type.Object({
  mode: Type.Union(
    [Type.Literal("in"), Type.Literal("at"), Type.Literal("cron")],
    { default: "in", description: "\"in\" for relative delay, \"at\" for absolute local datetime, \"cron\" for recurring schedules." },
  ),
  instructions: Type.String({ description: "Detailed instruction for the future scheduled turn, not literal text to send. Include original user intent, who to notify, whether to ping, desired wording/tone, and any needed context." }),
  amount: Type.Optional(Type.Number({ description: "How many units from now. Required when mode is \"in\"." })),
  unit: Type.Optional(Type.Union(
    [Type.Literal("seconds"), Type.Literal("minutes"), Type.Literal("hours")],
    { description: "Time unit. Required when mode is \"in\"." },
  )),
  localDateTime: Type.Optional(Type.String({ description: "Local date-time as YYYY-MM-DD HH:mm (guild timezone). Required when mode is \"at\"." })),
  cronExpression: Type.Optional(Type.String({ description: "Cron expression for recurring schedules. Required when mode is \"cron\". Uses the guild timezone." })),
});

const ListScheduledMessagesParams = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Maximum schedules to return. Default: 20, max: 50." })),
});

const DeleteScheduledMessageParams = Type.Object({
  scheduleId: Type.String({ description: "ID of a pending scheduled message in the current channel." }),
});

type ScheduleResult = AgentToolResult<
  | { scheduleId: string; runAt: number }
  | { scheduleId: string; cronExpression: string; timezone: string }
  | { error: boolean }
>;

/** Create all schedule-related tools exposed to the chat agent. */
export function createScheduleTools(deps: ScheduleToolDeps): AgentTool[] {
  return [
    createScheduleTool(deps),
    createListScheduledMessagesTool(deps),
    createDeleteScheduledMessageTool(deps),
  ];
}

/** Create a one-off or recurring scheduled message in the current channel. */
export function createScheduleTool(deps: ScheduleToolDeps): AgentTool {
  const { db, guildId, channelId, timezone, onScheduleCreated } = deps;

  return {
    name: "schedule_message",
    label: "schedule_message",
    description:
      "Schedule a message to be sent in the current channel. Modes: 'in' for relative delay (e.g. in 30 minutes), 'at' for absolute local datetime (e.g. 2026-06-15 10:00), and 'cron' for recurring schedules. 'at' and 'cron' use the guild timezone. For recurring schedules, avoid useless or annoying repeats; if there are already several pending schedules, especially around 10+ recurring schedules, inspect list_scheduled_messages and use caution unless an admin explicitly asked for the schedule. Reasonable low-noise recurring chat rituals such as a daily good morning message are fine.",
    parameters: ScheduleMessageParams,

    execute(
      _toolCallId: string,
      rawParams: unknown
    ): Promise<ScheduleResult> {
      const params = rawParams as Record<string, unknown>;
      const mode = (params.mode as string | undefined) ?? "in";

      if (mode === "at") {
        return handleAbsoluteMode(params, db, guildId, channelId, timezone, onScheduleCreated);
      }
      if (mode === "cron") {
        return handleCronMode(params, db, guildId, channelId, timezone, onScheduleCreated);
      }
      return handleRelativeMode(params, db, guildId, channelId, timezone, onScheduleCreated);
    },
  };
}

/** List pending scheduled messages for the current guild and channel. */
export function createListScheduledMessagesTool(deps: ScheduleToolDeps): AgentTool {
  const { db, guildId, channelId, timezone } = deps;

  return {
    name: "list_scheduled_messages",
    label: "list_scheduled_messages",
    description:
      "List pending scheduled messages in the current channel only. Use this to inspect reminders/follow-ups before answering or before deleting one.",
    parameters: ListScheduledMessagesParams,

    execute(
      _toolCallId: string,
      rawParams: unknown
    ): Promise<AgentToolResult<{ count: number; total: number }>> {
      const params = rawParams as { limit?: number };
      const limit = Math.max(1, Math.min(params.limit ?? 20, 50));
      const schedules = listPendingSchedules(db, { guildId, channelId });
      const visible = schedules.slice(0, limit);

      if (visible.length === 0) {
        return Promise.resolve({
          content: [{ type: "text", text: "No pending scheduled messages in this channel." }],
          details: { count: 0, total: 0 },
        });
      }

      const suffix = schedules.length > visible.length
        ? `\nShowing ${visible.length} of ${schedules.length}.`
        : "";
      return Promise.resolve({
        content: [{
          type: "text",
          text: `Pending scheduled messages in this channel (${schedules.length}):\n${visible.map((s) => formatScheduleForTool(s, timezone)).join("\n")}${suffix}`,
        }],
        details: { count: visible.length, total: schedules.length },
      });
    },
  };
}

/** Delete a pending scheduled message in the current guild and channel. */
export function createDeleteScheduledMessageTool(deps: ScheduleToolDeps): AgentTool {
  const { db, guildId, channelId, onScheduleDeleted } = deps;

  return {
    name: "delete_scheduled_message",
    label: "delete_scheduled_message",
    description:
      "Delete a pending scheduled message by ID in the current channel only. Use list_scheduled_messages first if the exact ID is not already known.",
    parameters: DeleteScheduledMessageParams,

    execute(
      _toolCallId: string,
      rawParams: unknown
    ): Promise<AgentToolResult<{ deleted: boolean; scheduleId?: string }>> {
      const params = rawParams as { scheduleId?: string };
      const scheduleId = params.scheduleId?.trim();
      if (scheduleId === undefined || scheduleId === "") {
        return Promise.resolve({
          content: [{ type: "text", text: "scheduleId is required." }],
          details: { deleted: false },
        });
      }

      const deleted = deletePendingSchedule(db, scheduleId, { guildId, channelId });
      if (!deleted) {
        return Promise.resolve({
          content: [{ type: "text", text: "No pending scheduled message with that ID exists in this channel." }],
          details: { deleted: false, scheduleId },
        });
      }

      onScheduleDeleted?.(scheduleId);
      return Promise.resolve({
        content: [{ type: "text", text: `Deleted pending scheduled message ${scheduleId}.` }],
        details: { deleted: true, scheduleId },
      });
    },
  };
}

function handleRelativeMode(
  params: Record<string, unknown>,
  db: Database, guildId: string, channelId: string, timezone: string,
  onScheduleCreated?: (id: string) => void,
): Promise<ScheduleResult> {
  const amount = params.amount as number | undefined;
  const unit = params.unit as string | undefined;
  const instructions = params.instructions as string;

  if (amount === undefined || unit === undefined) {
    return Promise.resolve({
      content: [{ type: "text", text: "mode \"in\" requires amount and unit." }],
      details: { error: true },
    });
  }

  if (amount <= 0) {
    return Promise.resolve({ content: [{ type: "text", text: "Amount must be positive." }], details: { error: true } });
  }

  const multiplier = UNIT_TO_MS[unit];
  if (multiplier === undefined) {
    return Promise.resolve({
      content: [{ type: "text", text: "Invalid unit. Use seconds, minutes, or hours." }],
      details: { error: true },
    });
  }

  const runAt = Date.now() + amount * multiplier;
  const id = createSchedule(db, {
    guildId,
    channelId,
    source: "tool",
    type: "one_off",
    runAt,
    timezone,
    messageContent: instructions,
  });

  onScheduleCreated?.(id);

  const localTime = formatLocalWallClock(runAt, timezone);
  return Promise.resolve({
    content: [{ type: "text", text: `Scheduled message in ${amount} ${unit} (fires at ${localTime}, ${timezone}).` }],
    details: { scheduleId: id, runAt },
  });
}

function formatScheduleForTool(schedule: ScheduleRow, timezone: string): string {
  const content = truncate(schedule.messageContent.replaceAll("\n", " "), 240);
  if (schedule.type === "cron") {
    return `- ${schedule.id} [cron ${schedule.cronExpression ?? "?"}, ${schedule.timezone}]: ${content}`;
  }
  const runDate = schedule.runAt !== null ? formatLocalWallClock(schedule.runAt, timezone) : "?";
  return `- ${schedule.id} [one-off at ${runDate}, ${timezone}]: ${content}`;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 3) + "...";
}

function handleAbsoluteMode(
  params: Record<string, unknown>,
  db: Database, guildId: string, channelId: string, timezone: string,
  onScheduleCreated?: (id: string) => void,
): Promise<ScheduleResult> {
  const localDateTime = params.localDateTime as string | undefined;
  const instructions = params.instructions as string;

  if (localDateTime === undefined) {
    return Promise.resolve({
      content: [{ type: "text", text: "mode \"at\" requires localDateTime in YYYY-MM-DD HH:mm format." }],
      details: { error: true },
    });
  }

  const parsed = parseLocalDateTimeToEpoch(localDateTime, timezone);
  if (!parsed.ok) {
    return Promise.resolve({
      content: [{ type: "text", text: parsed.error }],
      details: { error: true },
    });
  }

  if (parsed.epochMs <= Date.now()) {
    return Promise.resolve({
      content: [{ type: "text", text: "Time is in the past. Choose a future time." }],
      details: { error: true },
    });
  }

  const id = createSchedule(db, {
    guildId,
    channelId,
    source: "tool",
    type: "one_off",
    runAt: parsed.epochMs,
    timezone,
    messageContent: instructions,
  });

  onScheduleCreated?.(id);

  return Promise.resolve({
    content: [{ type: "text", text: `Scheduled for ${localDateTime} (${timezone}).` }],
    details: { scheduleId: id, runAt: parsed.epochMs },
  });
}

function handleCronMode(
  params: Record<string, unknown>,
  db: Database, guildId: string, channelId: string, timezone: string,
  onScheduleCreated?: (id: string) => void,
): Promise<ScheduleResult> {
  const cronExpression = (params.cronExpression as string | undefined)?.trim();
  const instructions = params.instructions as string;

  if (cronExpression === undefined || cronExpression === "") {
    return Promise.resolve({
      content: [{ type: "text", text: "mode \"cron\" requires cronExpression." }],
      details: { error: true },
    });
  }

  try {
    new CronPattern(cronExpression, timezone);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve({
      content: [{ type: "text", text: `Invalid cronExpression: ${message}` }],
      details: { error: true },
    });
  }

  const id = createSchedule(db, {
    guildId,
    channelId,
    source: "tool",
    type: "cron",
    cronExpression,
    timezone,
    messageContent: instructions,
  });

  onScheduleCreated?.(id);

  return Promise.resolve({
    content: [{ type: "text", text: `Scheduled recurring message with cron \`${cronExpression}\` (${timezone}).` }],
    details: { scheduleId: id, cronExpression, timezone },
  });
}
