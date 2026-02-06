import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Database } from "../db/database";
import { createSchedule } from "../db/schedule-repository";
import { formatLocalWallClock, parseLocalDateTimeToEpoch } from "../time/agent-time.ts";

export interface ScheduleToolDeps {
  db: Database;
  guildId: string;
  channelId: string;
  timezone: string;
  /** Called after schedule is created so the engine can register it at runtime. */
  onScheduleCreated?: (scheduleId: string) => void;
}

const UNIT_TO_MS: Record<string, number> = {
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
};

const ScheduleMessageParams = Type.Object({
  mode: Type.Union(
    [Type.Literal("in"), Type.Literal("at")],
    { default: "in", description: "\"in\" for relative delay, \"at\" for absolute local datetime." },
  ),
  message: Type.String({ description: "Detailed instruction for your future self (not user-facing text). Be comprehensive, provide context." }),
  amount: Type.Optional(Type.Number({ description: "How many units from now. Required when mode is \"in\"." })),
  unit: Type.Optional(Type.Union(
    [Type.Literal("seconds"), Type.Literal("minutes"), Type.Literal("hours")],
    { description: "Time unit. Required when mode is \"in\"." },
  )),
  localDateTime: Type.Optional(Type.String({ description: "Local date-time as YYYY-MM-DD HH:mm (guild timezone). Required when mode is \"at\"." })),
});

type ScheduleResult = AgentToolResult<{ scheduleId: string; runAt: number } | { error: boolean }>;

export function createScheduleTool(deps: ScheduleToolDeps): AgentTool {
  const { db, guildId, channelId, timezone, onScheduleCreated } = deps;

  return {
    name: "schedule_message",
    label: "schedule_message",
    description:
      "Schedule a message to be sent in the current channel. Two modes: 'in' for relative delay (e.g. in 30 minutes), 'at' for absolute local datetime (e.g. 2026-06-15 10:00). The 'at' mode uses the guild timezone.",
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
      return handleRelativeMode(params, db, guildId, channelId, timezone, onScheduleCreated);
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
  const message = params.message as string;

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
    messageContent: message,
  });

  onScheduleCreated?.(id);

  const localTime = formatLocalWallClock(runAt, timezone);
  return Promise.resolve({
    content: [{ type: "text", text: `Scheduled message in ${amount} ${unit} (fires at ${localTime}, ${timezone}).` }],
    details: { scheduleId: id, runAt },
  });
}

function handleAbsoluteMode(
  params: Record<string, unknown>,
  db: Database, guildId: string, channelId: string, timezone: string,
  onScheduleCreated?: (id: string) => void,
): Promise<ScheduleResult> {
  const localDateTime = params.localDateTime as string | undefined;
  const message = params.message as string;

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
    messageContent: message,
  });

  onScheduleCreated?.(id);

  return Promise.resolve({
    content: [{ type: "text", text: `Scheduled for ${localDateTime} (${timezone}).` }],
    details: { scheduleId: id, runAt: parsed.epochMs },
  });
}
