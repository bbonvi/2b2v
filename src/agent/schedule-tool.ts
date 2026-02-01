import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Database } from "../db/database";
import { createSchedule } from "../db/schedule-repository";

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
  amount: Type.Number({ description: "How many units from now." }),
  unit: Type.Union(
    [Type.Literal("seconds"), Type.Literal("minutes"), Type.Literal("hours")],
    { description: "Time unit: seconds, minutes, or hours." }
  ),
  message: Type.String({ description: "Message content to send when the schedule fires." }),
});

export function createScheduleTool(deps: ScheduleToolDeps): AgentTool {
  const { db, guildId, channelId, timezone, onScheduleCreated } = deps;

  return {
    name: "schedule_message",
    label: "schedule_message",
    description:
      "Schedule a message to be sent in the current channel after a relative delay (e.g. in 30 minutes).",
    parameters: ScheduleMessageParams,

    execute(
      _toolCallId: string,
      rawParams: unknown
    ): Promise<AgentToolResult<{ scheduleId: string; runAt: number } | { error: boolean }>> {
      const params = rawParams as { amount: number; unit: string; message: string };
      if (params.amount <= 0) {
        return Promise.resolve({ content: [{ type: "text", text: "Amount must be positive." }], details: { error: true } });
      }

      const multiplier = UNIT_TO_MS[params.unit];
      if (multiplier === undefined) {
        return Promise.resolve({
          content: [{ type: "text", text: "Invalid unit. Use seconds, minutes, or hours." }],
          details: { error: true },
        });
      }

      const runAt = Date.now() + params.amount * multiplier;
      const id = createSchedule(db, {
        guildId,
        channelId,
        source: "tool",
        type: "one_off",
        runAt,
        timezone,
        messageContent: params.message,
      });

      onScheduleCreated?.(id);

      const fireDate = new Date(runAt);
      return Promise.resolve({
        content: [{ type: "text", text: `Scheduled message in ${params.amount} ${params.unit} (fires at ${fireDate.toISOString()}).` }],
        details: { scheduleId: id, runAt },
      });
    },
  };
}
