import { describe, expect, test } from "bun:test";
import { createDatabase } from "../db/database";
import { createSchedule, getSchedule } from "../db/schedule-repository";
import { createUpdateCurrentScheduledTaskTool } from "./current-task-tool";

describe("update_current_scheduled_task", () => {
  test("updates full handoff note and can complete recurring task", async () => {
    const db = createDatabase(":memory:");
    const id = createSchedule(db, {
      guildId: "g1",
      channelId: "c1",
      source: "tool",
      type: "cron",
      cronExpression: "*/5 * * * *",
      timezone: "UTC",
      messageContent: "check item",
      handoffNote: "old state",
    });
    const completed: string[] = [];
    const tool = createUpdateCurrentScheduledTaskTool({
      db,
      scheduleId: id,
      onCompleted: (scheduleId) => completed.push(scheduleId),
    });

    const result = await tool.execute("u1", {
      handoffNote: "Checking item X for alice; last checked now; still out of stock; notify only if in stock.",
      complete: true,
    }, new AbortController().signal);

    expect(result.details).toEqual({ updated: true, complete: true });
    expect(getSchedule(db, id)?.handoffNote).toContain("Checking item X");
    expect(getSchedule(db, id)?.enabled).toBe(false);
    expect(completed).toEqual([id]);
    db.close();
  });
});
