import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Cron, CronPattern } from "croner";
import type { Database } from "../db/database";
import {
  createSchedule,
  deletePendingSchedule,
  listPendingSchedules,
  type ScheduleRow,
} from "../db/schedule-repository";
import { formatLocalWallClock, parseLocalDateTimeToEpoch } from "../time/agent-time.ts";
import type { SchedulePressureConfig } from "../config/types.ts";
import { DEFAULT_SCHEDULE_PRESSURE } from "../config/defaults.ts";

export interface ScheduleToolDeps {
  db: Database;
  guildId: string;
  channelId: string;
  timezone: string;
  currentRequest?: {
    requesterId: string;
    requesterUsername: string;
  };
  isRequesterAdmin?: boolean;
  schedulePressure?: SchedulePressureConfig;
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
const ScheduleTaskParams = Type.Object({
  mode: Type.Union(
    [Type.Literal("in"), Type.Literal("at"), Type.Literal("cron")],
    { default: "in", description: "Schedule mode." },
  ),
  instructions: Type.String({ description: "Instruction for the future scheduled turn." }),
  amount: Type.Optional(Type.Number({ description: "How many units from now. Required when mode is \"in\"." })),
  unit: Type.Optional(Type.Union(
    [Type.Literal("seconds"), Type.Literal("minutes"), Type.Literal("hours")],
    { description: "Time unit. Required when mode is \"in\"." },
  )),
  localDateTime: Type.Optional(Type.String({ description: "Local date-time for mode at." })),
  cronExpression: Type.Optional(Type.String({ description: "Cron expression for recurring schedules." })),
  expiresAtLocalDateTime: Type.Optional(Type.String({ description: "Local date-time after which a recurring schedule stops." })),
  maxFireCount: Type.Optional(Type.Number({ description: "Maximum times a recurring schedule may fire." })),
});

const ListScheduledTasksParams = Type.Object({
  limit: Type.Optional(Type.Number({ description: "Maximum schedules to return." })),
});

const DeleteScheduledTaskParams = Type.Object({
  scheduleId: Type.String({ description: "ID of a pending scheduled task in the current channel." }),
});

type ScheduleResult = AgentToolResult<
  | { scheduleId: string; runAt: number }
  | { scheduleId: string; cronExpression: string; timezone: string; expiresAt?: number; maxFireCount?: number }
  | { error: boolean }
>;

type CronPressure = {
  hour: number;
  day: number;
};

/** Create all schedule-related tools exposed to the chat agent. */
export function createScheduleTools(deps: ScheduleToolDeps): AgentTool[] {
  return [
    createScheduleTaskTool(deps),
    createListScheduledTasksTool(deps),
    createDeleteScheduledTaskTool(deps),
  ];
}

/** Create a one-off or recurring scheduled task in the current channel. */
export function createScheduleTaskTool(deps: ScheduleToolDeps): AgentTool {
  const { db, guildId, channelId, timezone, onScheduleCreated } = deps;

  return {
    name: "schedule_task",
    label: "schedule_task",
    description: "Schedule a private task in the current channel.",
    parameters: ScheduleTaskParams,

    execute(
      _toolCallId: string,
      rawParams: unknown
    ): Promise<ScheduleResult> {
      const params = rawParams as Record<string, unknown>;
      const mode = (params.mode as string | undefined) ?? "in";

      if (mode === "at") {
        return handleAbsoluteMode(params, db, guildId, channelId, timezone, deps.currentRequest, onScheduleCreated);
      }
      if (mode === "cron") {
        return handleCronMode(params, deps);
      }
      return handleRelativeMode(params, db, guildId, channelId, timezone, deps.currentRequest, onScheduleCreated);
    },
  };
}

/** List pending scheduled tasks for the current guild and channel. */
export function createListScheduledTasksTool(deps: ScheduleToolDeps): AgentTool {
  const { db, guildId, channelId, timezone } = deps;

  return {
    name: "list_scheduled_tasks",
    label: "list_scheduled_tasks",
    description: "List pending scheduled tasks in the current channel.",
    parameters: ListScheduledTasksParams,

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
          content: [{ type: "text", text: "No pending scheduled tasks in this channel." }],
          details: { count: 0, total: 0 },
        });
      }

      const suffix = schedules.length > visible.length
        ? `\nShowing ${visible.length} of ${schedules.length}.`
        : "";
      return Promise.resolve({
        content: [{
          type: "text",
          text: `Pending scheduled tasks in this channel (${schedules.length}):\n${visible.map((s) => formatScheduleForTool(s, timezone)).join("\n")}${suffix}`,
        }],
        details: { count: visible.length, total: schedules.length },
      });
    },
  };
}

/** Delete a pending scheduled task in the current guild and channel. */
export function createDeleteScheduledTaskTool(deps: ScheduleToolDeps): AgentTool {
  const { db, guildId, channelId, onScheduleDeleted } = deps;

  return {
    name: "delete_scheduled_task",
    label: "delete_scheduled_task",
    description: "Delete a pending scheduled task in the current channel.",
    parameters: DeleteScheduledTaskParams,

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
          content: [{ type: "text", text: "No pending scheduled task with that ID exists in this channel." }],
          details: { deleted: false, scheduleId },
        });
      }

      onScheduleDeleted?.(scheduleId);
      return Promise.resolve({
        content: [{ type: "text", text: `Deleted pending scheduled task ${scheduleId}.` }],
        details: { deleted: true, scheduleId },
      });
    },
  };
}

function requesterFields(request?: ScheduleToolDeps["currentRequest"]): {
  createdByUserId?: string;
  createdByUsername?: string;
} {
  if (request === undefined || request.requesterId === "scheduler") return {};
  return {
    createdByUserId: request.requesterId,
    createdByUsername: request.requesterUsername,
  };
}

function handleRelativeMode(
  params: Record<string, unknown>,
  db: Database, guildId: string, channelId: string, timezone: string,
  currentRequest: ScheduleToolDeps["currentRequest"],
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
      content: [{ type: "text", text: "Invalid unit; use seconds, minutes, or hours." }],
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
    ...requesterFields(currentRequest),
  });

  onScheduleCreated?.(id);

  const localTime = formatLocalWallClock(runAt, timezone);
  return Promise.resolve({
    content: [{ type: "text", text: `Scheduled task in ${amount} ${unit} (fires at ${localTime}, ${timezone}).` }],
    details: { scheduleId: id, runAt },
  });
}

function formatScheduleForTool(schedule: ScheduleRow, timezone: string): string {
  const content = truncate(schedule.messageContent.replaceAll("\n", " "), 220);
  const owner = schedule.createdByUsername !== null ? ` owner=${schedule.createdByUsername}` : "";
  const count = schedule.fireCount > 0 ? ` fired=${schedule.fireCount}` : "";
  const handoff = schedule.handoffNote.trim() !== "" ? ` handoff=${truncate(schedule.handoffNote.replaceAll("\n", " "), 500)}` : "";
  if (schedule.type === "cron") {
    const expires = schedule.expiresAt !== null ? ` expires=${formatLocalWallClock(schedule.expiresAt, schedule.timezone)}` : "";
    const max = schedule.maxFireCount !== null ? ` max=${schedule.maxFireCount}` : "";
    return `- ${schedule.id} [cron ${schedule.cronExpression ?? "?"}, ${schedule.timezone}${owner}${count}${expires}${max}]: ${content}${handoff}`;
  }
  const runDate = schedule.runAt !== null ? formatLocalWallClock(schedule.runAt, timezone) : "?";
  return `- ${schedule.id} [one-off at ${runDate}, ${timezone}${owner}${count}]: ${content}${handoff}`;
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 3) + "...";
}

function handleAbsoluteMode(
  params: Record<string, unknown>,
  db: Database, guildId: string, channelId: string, timezone: string,
  currentRequest: ScheduleToolDeps["currentRequest"],
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
      content: [{ type: "text", text: "Time is in the past; choose a future time." }],
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
    ...requesterFields(currentRequest),
  });

  onScheduleCreated?.(id);

  return Promise.resolve({
    content: [{ type: "text", text: `Scheduled task for ${localDateTime} (${timezone}).` }],
    details: { scheduleId: id, runAt: parsed.epochMs },
  });
}

function parseCronCeilings(params: Record<string, unknown>, timezone: string): {
  expiresAt?: number;
  maxFireCount?: number;
  error?: string;
} {
  const expiresAtLocalDateTime = params.expiresAtLocalDateTime as string | undefined;
  const maxFireCount = params.maxFireCount as number | undefined;
  const out: { expiresAt?: number; maxFireCount?: number; error?: string } = {};
  if (expiresAtLocalDateTime !== undefined) {
    const parsed = parseLocalDateTimeToEpoch(expiresAtLocalDateTime, timezone);
    if (!parsed.ok) return { error: parsed.error };
    if (parsed.epochMs <= Date.now()) return { error: "expiresAtLocalDateTime is in the past; choose a future time." };
    out.expiresAt = parsed.epochMs;
  }
  if (maxFireCount !== undefined) {
    if (!Number.isInteger(maxFireCount) || maxFireCount <= 0) return { error: "maxFireCount must be a positive integer." };
    out.maxFireCount = maxFireCount;
  }
  return out;
}

function cronPressure(expression: string, timezone: string, now: number, ceilings: { expiresAt?: number; maxFireCount?: number }): CronPressure {
  const cron = new Cron(expression, { timezone, paused: true });
  const hourEnd = now + 60 * 60_000;
  const dayEnd = now + 24 * 60 * 60_000;
  const end = Math.min(dayEnd, ceilings.expiresAt ?? dayEnd);
  const runs = cron.nextRuns(Math.max(ceilings.maxFireCount ?? 10_000, 1), new Date(now))
    .map((date) => date.getTime())
    .filter((time) => time <= end);
  const limitedRuns = ceilings.maxFireCount !== undefined ? runs.slice(0, ceilings.maxFireCount) : runs;
  return {
    hour: limitedRuns.filter((time) => time <= hourEnd).length,
    day: limitedRuns.length,
  };
}

function activeCronPressure(schedules: ScheduleRow[], now: number, forUserId?: string): CronPressure {
  return schedules
    .filter((schedule) =>
      schedule.type === "cron"
      && schedule.cronExpression !== null
      && (forUserId === undefined || schedule.createdByUserId === forUserId)
    )
    .reduce<CronPressure>((sum, schedule) => {
      const remainingMax = schedule.maxFireCount !== null
        ? Math.max(0, schedule.maxFireCount - schedule.fireCount)
        : undefined;
      try {
        const pressure = cronPressure(schedule.cronExpression ?? "", schedule.timezone, now, {
          ...(schedule.expiresAt !== null ? { expiresAt: schedule.expiresAt } : {}),
          ...(remainingMax !== undefined ? { maxFireCount: remainingMax } : {}),
        });
        return { hour: sum.hour + pressure.hour, day: sum.day + pressure.day };
      } catch {
        return sum;
      }
    }, { hour: 0, day: 0 });
}

function rejectIfTooMuchCronPressure(
  params: {
    db: Database;
    guildId: string;
    requesterId?: string;
    isRequesterAdmin: boolean;
    cronExpression: string;
    timezone: string;
    ceilings: { expiresAt?: number; maxFireCount?: number };
    schedulePressure: SchedulePressureConfig;
  },
): string | null {
  if (params.isRequesterAdmin) return null;
  const now = Date.now();
  const schedules = listPendingSchedules(params.db, { guildId: params.guildId });
  const proposed = cronPressure(params.cronExpression, params.timezone, now, params.ceilings);
  const guildPressure = activeCronPressure(schedules, now);
  const requesterPressure = params.requesterId !== undefined
    ? activeCronPressure(schedules, now, params.requesterId)
    : { hour: 0, day: 0 };
  const nextRequester = { hour: requesterPressure.hour + proposed.hour, day: requesterPressure.day + proposed.day };
  const nextGuild = { hour: guildPressure.hour + proposed.hour, day: guildPressure.day + proposed.day };
  if (nextRequester.hour > params.schedulePressure.maxRequesterRunsPerHour || nextRequester.day > params.schedulePressure.maxRequesterRunsPerDay) {
    return `That would create too many recurring task runs for this requester (${nextRequester.hour}/hour, ${nextRequester.day}/day). Add a shorter ceiling or a less frequent cadence.`;
  }
  if (nextGuild.hour > params.schedulePressure.maxGuildRunsPerHour || nextGuild.day > params.schedulePressure.maxGuildRunsPerDay) {
    return `That would create too many recurring task runs for this guild (${nextGuild.hour}/hour, ${nextGuild.day}/day). Add a shorter ceiling or a less frequent cadence.`;
  }
  return null;
}

function handleCronMode(
  params: Record<string, unknown>,
  deps: ScheduleToolDeps,
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
    new CronPattern(cronExpression, deps.timezone);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve({
      content: [{ type: "text", text: `Invalid cronExpression: ${message}` }],
      details: { error: true },
    });
  }

  const ceilings = parseCronCeilings(params, deps.timezone);
  if (ceilings.error !== undefined) {
    return Promise.resolve({
      content: [{ type: "text", text: ceilings.error }],
      details: { error: true },
    });
  }
  const pressureRejection = rejectIfTooMuchCronPressure({
    db: deps.db,
    guildId: deps.guildId,
    requesterId: deps.currentRequest?.requesterId,
    isRequesterAdmin: deps.isRequesterAdmin === true,
    cronExpression,
    timezone: deps.timezone,
    ceilings,
    schedulePressure: deps.schedulePressure ?? DEFAULT_SCHEDULE_PRESSURE,
  });
  if (pressureRejection !== null) {
    return Promise.resolve({
      content: [{ type: "text", text: pressureRejection }],
      details: { error: true },
    });
  }

  const id = createSchedule(deps.db, {
    guildId: deps.guildId,
    channelId: deps.channelId,
    source: "tool",
    type: "cron",
    cronExpression,
    timezone: deps.timezone,
    messageContent: instructions,
    ...requesterFields(deps.currentRequest),
    ...(ceilings.expiresAt !== undefined ? { expiresAt: ceilings.expiresAt } : {}),
    ...(ceilings.maxFireCount !== undefined ? { maxFireCount: ceilings.maxFireCount } : {}),
  });

  deps.onScheduleCreated?.(id);

  const ceilingText = [
    ceilings.expiresAt !== undefined ? `expires ${formatLocalWallClock(ceilings.expiresAt, deps.timezone)}` : "",
    ceilings.maxFireCount !== undefined ? `max ${ceilings.maxFireCount} runs` : "",
  ].filter((part) => part !== "").join(", ");
  return Promise.resolve({
    content: [{ type: "text", text: `Scheduled recurring task with cron \`${cronExpression}\` (${deps.timezone})${ceilingText !== "" ? `; ${ceilingText}` : ""}.` }],
    details: {
      scheduleId: id,
      cronExpression,
      timezone: deps.timezone,
      ...(ceilings.expiresAt !== undefined ? { expiresAt: ceilings.expiresAt } : {}),
      ...(ceilings.maxFireCount !== undefined ? { maxFireCount: ceilings.maxFireCount } : {}),
    },
  });
}
