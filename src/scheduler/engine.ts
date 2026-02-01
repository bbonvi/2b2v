import { Cron } from "croner";
import type { Database } from "../db/database";
import {
  listSchedules,
  getSchedule,
  updateSchedule,
  type ScheduleRow,
} from "../db/schedule-repository";

export interface ScheduleFireEvent {
  schedule: ScheduleRow;
}

export interface SchedulerEngineOptions {
  db: Database;
  onFire: (event: ScheduleFireEvent) => void;
  log?: SchedulerLogger;
  /** Not currently used; reserved for future polling. */
  pollIntervalMs?: number;
}

/** Minimal logging interface to avoid hard dependency on logger module. */
export interface SchedulerLogger {
  error(msg: string, fields?: Record<string, unknown>): void;
}

interface ActiveJob {
  cron?: Cron;
  timer?: ReturnType<typeof setTimeout>;
  scheduleId: string;
}

export interface SchedulerEngine {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  activeCount(): number;
  addSchedule(scheduleId: string): void;
  removeSchedule(scheduleId: string): void;
}

export function createSchedulerEngine(
  options: SchedulerEngineOptions
): SchedulerEngine {
  const { db, onFire, log } = options;
  const jobs = new Map<string, ActiveJob>();
  let running = false;

  const noopLog: SchedulerLogger = { error: () => {} };
  const logger = log ?? noopLog;

  function loadAll(): void {
    // Load all enabled schedules across all guilds.
    // We query raw since listSchedules requires a guildId filter.
    const rows = db.raw
      .prepare("SELECT DISTINCT guild_id FROM schedules WHERE enabled = 1")
      .all() as { guild_id: string }[];

    for (const { guild_id } of rows) {
      const schedules = listSchedules(db, {
        guildId: guild_id,
        enabled: true,
      });
      for (const schedule of schedules) {
        scheduleJob(schedule);
      }
    }
  }

  function scheduleJob(schedule: ScheduleRow): void {
    // Skip if already tracked
    if (jobs.has(schedule.id)) return;

    if (schedule.type === "cron" && schedule.cronExpression !== null && schedule.cronExpression !== "") {
      try {
        const cron = new Cron(schedule.cronExpression, {
          timezone: schedule.timezone,
          catch: (err) => {
            logger.error("cron execution error", {
              scheduleId: schedule.id,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        }, () => {
          fire(schedule.id);
        });
        jobs.set(schedule.id, { cron, scheduleId: schedule.id });
      } catch (err) {
        logger.error("invalid cron expression", {
          scheduleId: schedule.id,
          cronExpression: schedule.cronExpression,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (schedule.type === "one_off" && schedule.runAt !== null) {
      const delayMs = schedule.runAt - Date.now();
      if (delayMs <= 0) {
        // Past one-off — auto-disable
        updateSchedule(db, schedule.id, { enabled: false });
        return;
      }
      const timer = setTimeout(() => {
        fire(schedule.id);
      }, delayMs);
      jobs.set(schedule.id, { timer, scheduleId: schedule.id });
    }
  }

  function fire(scheduleId: string): void {
    const schedule = getSchedule(db, scheduleId);
    if (!schedule || !schedule.enabled) return;

    // For one-offs, auto-disable after firing
    if (schedule.type === "one_off") {
      updateSchedule(db, scheduleId, { enabled: false });
      jobs.delete(scheduleId);
    }

    onFire({ schedule });
  }

  function clearJob(id: string): void {
    const job = jobs.get(id);
    if (!job) return;
    if (job.cron) job.cron.stop();
    if (job.timer) clearTimeout(job.timer);
    jobs.delete(id);
  }

  return {
    start() {
      if (running) return;
      running = true;
      loadAll();
    },

    stop() {
      running = false;
      for (const [id] of jobs) {
        clearJob(id);
      }
      jobs.clear();
    },

    isRunning() {
      return running;
    },

    activeCount() {
      return jobs.size;
    },

    addSchedule(scheduleId: string) {
      const schedule = getSchedule(db, scheduleId);
      if (!schedule || !schedule.enabled) return;
      scheduleJob(schedule);
    },

    removeSchedule(scheduleId: string) {
      clearJob(scheduleId);
    },
  };
}
