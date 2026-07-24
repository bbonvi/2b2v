export { createDatabase, type Database } from "./database";

export {
  createMemory,
  updateMemory,
  deleteMemory,
  getMemory,
  listMemories,
  deleteExpiredMemories,
  type MemoryKind,
  type MemoryRow,
  type CreateMemoryInput,
  type UpdateMemoryInput,
  type ListMemoriesFilter,
} from "./memory-repository";

export { type MessageSearchFilter, type MessageSearchResult } from "./message-repository";

export {
  createSchedule,
  updateSchedule,
  deleteSchedule,
  deleteScheduleForGuild,
  deletePendingSchedule,
  incrementScheduleFireCount,
  getSchedule,
  listSchedules,
  listPendingSchedules,
  listUpcomingForContext,
  type ScheduleSource,
  type ScheduleType,
  type ScheduleRow,
  type CreateScheduleInput,
  type UpdateScheduleInput,
  type ListSchedulesFilter,
  type PendingSchedulesFilter,
} from "./schedule-repository";

export {
  claimEventWatchFire,
  countActiveWatches,
  createEventWatch,
  deleteEventWatch,
  eventWatchFirePressureAllowsExecution,
  getEventWatch,
  getEventWatchFire,
  listCandidateEventWatches,
  listEventWatches,
  listPendingEventWatchFires,
  listPendingWatchMessageIds,
  markWatchMessageProcessed,
  setEventWatchThresholdArmed,
  updateEventWatch,
  updateEventWatchFireState,
  type CreateEventWatchInput,
  type EventWatchFire,
  type EventWatchScope,
} from "./event-watch-repository.ts";
