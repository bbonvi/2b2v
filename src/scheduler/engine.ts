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
  /** Test hook for exercising long one-off timers without waiting days. */
  maxOneOffTimerDelayMs?: number;
  timers?: SchedulerTimerApi;
  createCron?: CreateCron;
}

/** Minimal logging interface to avoid hard dependency on logger module. */
export interface SchedulerLogger {
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface SchedulerTimerApi {
  now(): number;
  setTimeout(callback: () => void, ms: number): SchedulerTimer;
  clearTimeout(timer: SchedulerTimer): void;
}

export type SchedulerTimer = object | number;

export interface CronHandle {
  stop(): void;
}

export type CreateCron = (
  expression: string,
  options: { timezone: string; catch: (err: unknown) => void },
  callback: () => void,
) => CronHandle;

interface ActiveJob {
  cron?: CronHandle;
  timer?: SchedulerTimer;
  scheduleId: string;
}

const MAX_ONE_OFF_TIMER_DELAY_MS = 2_147_483_647;

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
  const timers = options.timers ?? {
    now: () => Date.now(),
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (timer: SchedulerTimer) => { clearTimeout(timer as ReturnType<typeof setTimeout>); },
  };
  const createCron = options.createCron ?? ((expression, cronOptions, callback) =>
    new Cron(expression, cronOptions, callback));
  const maxOneOffTimerDelayMs = Math.min(
    options.maxOneOffTimerDelayMs ?? MAX_ONE_OFF_TIMER_DELAY_MS,
    MAX_ONE_OFF_TIMER_DELAY_MS,
  );
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
        const cron = createCron(schedule.cronExpression, {
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
      scheduleOneOff(schedule, false);
    }
  }

  function scheduleOneOff(schedule: ScheduleRow, fireWhenDue: boolean): void {
    if (schedule.runAt === null) return;

    const delayMs = schedule.runAt - timers.now();
    if (delayMs <= 0) {
      if (fireWhenDue) {
        fire(schedule.id);
      } else {
        // Past one-offs found during startup should not fire unexpectedly.
        updateSchedule(db, schedule.id, { enabled: false });
      }
      return;
    }

    const timerDelayMs = Math.min(delayMs, maxOneOffTimerDelayMs);
    const timer = timers.setTimeout(() => {
      jobs.delete(schedule.id);
      const latest = getSchedule(db, schedule.id);
      if (!latest || !latest.enabled || latest.type !== "one_off") return;
      scheduleOneOff(latest, true);
    }, timerDelayMs);
    jobs.set(schedule.id, { timer, scheduleId: schedule.id });
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
    if (job === undefined) return;
    if (job.cron !== undefined) job.cron.stop();
    if (job.timer !== undefined) timers.clearTimeout(job.timer);
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
