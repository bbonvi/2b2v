import type { TriggerResult } from "../agent/triggers.ts";
import type { DispatcherConfig, TriggerConfig } from "../config/types";

export type DispatchTrigger = NonNullable<TriggerResult>;

/** A pending message waiting to be dispatched. */
export interface PendingMessage {
  /** Discord message ID. */
  id: string;
  /** The discord.js Message object. */
  message: unknown;
  /** Date.now() when enqueue() fired. */
  receivedAt: number;
  /** Discord author ID. */
  authorId: string;
  /** Trigger result for this individual message, if any. */
  triggerResult: TriggerResult;
}

export interface SelectedDispatchTrigger {
  result: DispatchTrigger;
  message: PendingMessage;
}

export interface DispatchOutcome {
  /**
   * Message IDs that were already surfaced to the agent context/tool results
   * during the current run and should not be replayed as separate runs.
   */
  coveredMessageIds?: string[];
}

/** Handler function that the dispatcher calls with accumulated messages. */
export type DispatchHandler = (
  messages: PendingMessage[],
  trigger: SelectedDispatchTrigger | null,
) => Promise<DispatchOutcome | undefined>;

export interface EnqueueOptions {
  authorId: string;
  triggerResult: TriggerResult;
}

type DispatcherDebugEvent =
  | "dispatcher_enqueue"
  | "dispatcher_typing"
  | "dispatcher_debounce_wait"
  | "dispatcher_debounce_dispatch"
  | "dispatcher_debounce_queue";

type DispatcherDebug = (event: DispatcherDebugEvent, fields: Record<string, unknown>) => void;

const MAX_SUPPRESSED_IDS = 1000;

export type DispatcherTimer = object | number;

export interface DispatcherTimerApi {
  now(): number;
  setTimeout(callback: () => void, ms: number): DispatcherTimer;
  clearTimeout(timer: DispatcherTimer): void;
}

interface ChannelState {
  pending: PendingMessage[];
  debounceTimer: DispatcherTimer | null;
  running: boolean;
  queued: PendingMessage[];
  suppressedIds: Set<string>;
  suppressedOrder: string[];
  typingByUser: Map<string, number>;
  typingResumeGraceUntilByUser: Map<string, number>;
}

export interface ChannelDispatcher {
  /** Enqueue a message for processing. Returns false after draining begins. */
  enqueue(message: unknown, options: EnqueueOptions): boolean;
  /** Record a typing start event for a user in a channel. */
  recordTyping(channelId: string, userId: string): void;
  /** Stop accepting work, flush debounce waits, and resolve when all accepted work finishes. */
  drain(): Promise<void>;
  /** Shut down all timers and pending state. */
  dispose(): void;
}

export function selectDispatchTrigger(messages: readonly PendingMessage[]): SelectedDispatchTrigger | null {
  let selected: SelectedDispatchTrigger | null = null;
  for (const message of messages) {
    if (message.triggerResult === null) continue;
    if (
      selected === null ||
      triggerPriority(message.triggerResult) > triggerPriority(selected.result) ||
      (
        triggerPriority(message.triggerResult) === triggerPriority(selected.result) &&
        message.receivedAt >= selected.message.receivedAt
      )
    ) {
      selected = { result: message.triggerResult, message };
    }
  }
  return selected;
}

function selectNextDispatchTrigger(messages: readonly PendingMessage[]): SelectedDispatchTrigger | null {
  for (const message of messages) {
    if (message.triggerResult !== null) {
      return { result: message.triggerResult, message };
    }
  }
  return null;
}

function messageReplyTargetId(message: PendingMessage): string | null {
  const reference = (message.message as { reference?: { messageId?: unknown } | null }).reference;
  return typeof reference?.messageId === "string" ? reference.messageId : null;
}

/**
 * Extend a triggered turn through ordinary split messages without crossing an
 * explicit Discord reply into another conversational branch.
 */
function sameAuthorFollowupEndIndex(
  batch: readonly PendingMessage[],
  trigger: SelectedDispatchTrigger,
  triggerIndex: number,
): number {
  if (!allowsSameAuthorFollowup(trigger.result)) return triggerIndex;

  const branchMessageIds = new Set([trigger.message.id]);
  const triggerReplyTargetId = messageReplyTargetId(trigger.message);
  if (triggerReplyTargetId !== null) branchMessageIds.add(triggerReplyTargetId);

  let endIndex = triggerIndex;
  for (let i = triggerIndex + 1; i < batch.length; i += 1) {
    const message = batch[i];
    if (message === undefined || message.triggerResult !== null) break;
    if (message.authorId !== trigger.message.authorId) continue;

    const replyTargetId = messageReplyTargetId(message);
    if (replyTargetId !== null && !branchMessageIds.has(replyTargetId)) break;

    branchMessageIds.add(message.id);
    endIndex = i;
  }
  return endIndex;
}

/**
 * Choose the concrete message to process for a selected trigger.
 * Typing-aware triggers may include same-author follow-up text after the
 * triggering message. Random triggers stay pinned to the actual triggering
 * message so Discord replies do not target unrelated non-triggering chatter.
 */
export function selectDispatchMessageForTrigger(
  batch: readonly PendingMessage[],
  trigger: SelectedDispatchTrigger,
): PendingMessage | undefined {
  if (allowsSameAuthorFollowup(trigger.result)) {
    const triggerIndex = batch.findIndex((message) => message.id === trigger.message.id);
    if (triggerIndex === -1) return trigger.message;
    const endIndex = sameAuthorFollowupEndIndex(batch, trigger, triggerIndex);
    for (let i = endIndex; i >= triggerIndex; i -= 1) {
      const message = batch[i];
      if (message !== undefined && message.authorId === trigger.message.authorId) return message;
    }
    return trigger.message;
  }

  return trigger.message;
}

/**
 * Return the messages that belong to the current agent turn for a selected
 * trigger. Mention/keyword turns include same-author followups that were held
 * by the debounce window; random turns stay pinned to the triggering message.
 */
export function selectDispatchMessagesForTrigger(
  batch: readonly PendingMessage[],
  trigger: SelectedDispatchTrigger,
): PendingMessage[] {
  const selected = selectDispatchMessageForTrigger(batch, trigger);
  if (selected === undefined) return [];
  if (!allowsSameAuthorFollowup(trigger.result)) return [trigger.message];

  const triggerIndex = batch.findIndex((message) => message.id === trigger.message.id);
  if (triggerIndex === -1) return [selected];
  const endIndex = sameAuthorFollowupEndIndex(batch, trigger, triggerIndex);

  let startIndex = triggerIndex;
  for (let i = triggerIndex - 1; i >= 0; i -= 1) {
    const message = batch[i];
    if (message === undefined || message.triggerResult !== null || message.authorId !== trigger.message.authorId) break;
    startIndex = i;
  }

  return batch
    .slice(startIndex, endIndex + 1)
    .filter((message) => message.authorId === trigger.message.authorId);
}

function takeNextDispatchBatch(state: ChannelState): {
  batch: PendingMessage[];
  trigger: SelectedDispatchTrigger | null;
} {
  const trigger = selectNextDispatchTrigger(state.pending);
  if (trigger === null) {
    const batch = state.pending;
    state.pending = [];
    return { batch, trigger };
  }

  const triggerIndex = state.pending.findIndex((message) => message.id === trigger.message.id);
  if (triggerIndex === -1) {
    const batch = state.pending;
    state.pending = [];
    return { batch, trigger };
  }

  const endIndex = sameAuthorFollowupEndIndex(state.pending, trigger, triggerIndex);

  const batch = state.pending.slice(0, endIndex + 1);
  state.pending = state.pending.slice(endIndex + 1);
  return { batch, trigger };
}

/**
 * Create a channel dispatcher that debounces and serializes handler execution
 * per channel. Prevents duplicate responses when multiple messages arrive
 * during processing.
 */
export function createChannelDispatcher(opts: {
  config: DispatcherConfig;
  triggers: TriggerConfig;
  handler: DispatchHandler;
  debug?: DispatcherDebug;
  timers?: DispatcherTimerApi;
}): ChannelDispatcher {
  const { config, triggers, handler, debug } = opts;
  const timers = opts.timers ?? {
    now: () => Date.now(),
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (timer: DispatcherTimer) => { clearTimeout(timer as ReturnType<typeof setTimeout>); },
  };
  const channels = new Map<string, ChannelState>();
  let accepting = true;
  let drainPromise: Promise<void> | null = null;
  let resolveDrain: (() => void) | null = null;

  function allChannelsIdle(): boolean {
    for (const state of channels.values()) {
      if (state.running || state.pending.length > 0 || state.queued.length > 0 || state.debounceTimer !== null) {
        return false;
      }
    }
    return true;
  }

  function resolveDrainIfIdle(): void {
    if (resolveDrain === null || !allChannelsIdle()) return;
    const resolve = resolveDrain;
    resolveDrain = null;
    resolve();
  }

  function getChannelId(message: unknown): string {
    // duck-type: discord.js Message has channelId
    return (message as { channelId: string }).channelId;
  }

  function getMessageId(message: unknown): string {
    // duck-type: discord.js Message has id
    return (message as { id: string }).id;
  }

  function getOrCreateState(channelId: string): ChannelState {
    let state = channels.get(channelId);
    if (state === undefined) {
      state = {
        pending: [],
        debounceTimer: null,
        running: false,
        queued: [],
        suppressedIds: new Set<string>(),
        suppressedOrder: [],
        typingByUser: new Map<string, number>(),
        typingResumeGraceUntilByUser: new Map<string, number>(),
      };
      channels.set(channelId, state);
    }
    return state;
  }

  function getDebounceMs(trigger: SelectedDispatchTrigger | null): number {
    if (trigger?.result.reason === "mention") {
      return typingWaitEnabled() ? Math.max(0, triggers.keywordDebounceMs) : Math.max(0, config.mentionDebounceMs);
    }
    if (trigger?.result.reason === "keyword") return Math.max(0, triggers.keywordDebounceMs);
    return Math.max(0, config.defaultDebounceMs);
  }

  function typingWaitEnabled(): boolean {
    return triggers.typingIdleMs > 0 && triggers.typingMaxWaitMs > 0;
  }

  function messageTimestamp(message: PendingMessage): number {
    const createdTimestamp = (message.message as { createdTimestamp?: unknown }).createdTimestamp;
    return typeof createdTimestamp === "number" ? createdTimestamp : message.receivedAt;
  }

  function latestMessageAtForUser(messages: readonly PendingMessage[], userId: string): number {
    let latest = 0;
    for (const message of messages) {
      if (message.authorId === userId) latest = Math.max(latest, messageTimestamp(message));
    }
    return latest;
  }

  function getTypingWaitMs(
    state: ChannelState,
    messages: readonly PendingMessage[],
    trigger: SelectedDispatchTrigger | null,
  ): number {
    if (trigger === null || !usesTypingWait(trigger.result)) return 0;
    if (!typingWaitEnabled()) return 0;

    const userId = trigger.message.authorId;
    const lastTypingAt = state.typingByUser.get(userId);
    const now = timers.now();
    if (lastTypingAt === undefined) {
      const graceUntil = state.typingResumeGraceUntilByUser.get(userId);
      if (graceUntil === undefined) return 0;
      if (graceUntil <= now) {
        state.typingResumeGraceUntilByUser.delete(userId);
        return 0;
      }
      return graceUntil - now;
    }

    const latestMessageAt = latestMessageAtForUser(messages, userId);
    if (lastTypingAt < latestMessageAt) {
      state.typingByUser.delete(userId);
      const graceUntil = state.typingResumeGraceUntilByUser.get(userId);
      if (graceUntil === undefined || graceUntil <= now) return 0;
      return graceUntil - now;
    }

    let latestReceivedAt = trigger.message.receivedAt;
    for (const message of messages) {
      if (message.authorId === userId) latestReceivedAt = Math.max(latestReceivedAt, message.receivedAt);
    }
    const idleReadyAt = lastTypingAt + triggers.typingIdleMs;
    // Same-author follow-ups mean the user is still composing this turn; cap
    // the wait from the latest chunk, not the original trigger.
    const maxReadyAt = latestReceivedAt + triggers.typingMaxWaitMs;
    const waitUntil = Math.min(idleReadyAt, maxReadyAt);
    return Math.max(0, waitUntil - now);
  }

  function rememberSuppressedId(state: ChannelState, id: string): void {
    if (id === "" || state.suppressedIds.has(id)) return;
    state.suppressedIds.add(id);
    state.suppressedOrder.push(id);
    if (state.suppressedOrder.length > MAX_SUPPRESSED_IDS) {
      const evicted = state.suppressedOrder.shift();
      if (evicted !== undefined) state.suppressedIds.delete(evicted);
    }
  }

  function suppressCoveredMessages(state: ChannelState, coveredMessageIds: readonly string[]): void {
    for (const id of coveredMessageIds) {
      rememberSuppressedId(state, id);
    }
    if (coveredMessageIds.length === 0) return;
    state.pending = state.pending.filter((m) => !state.suppressedIds.has(m.id));
    state.queued = state.queued.filter((m) => !state.suppressedIds.has(m.id));
  }

  function ensurePendingDebounce(channelId: string, state: ChannelState): void {
    if (state.pending.length === 0 || state.debounceTimer !== null) return;
    if (!accepting) {
      fireDebounce(channelId);
      return;
    }
    const trigger = selectDispatchTrigger(state.pending);
    state.debounceTimer = timers.setTimeout(
      () => fireDebounce(channelId),
      getDebounceMs(trigger),
    );
  }

  function fireDebounce(channelId: string): void {
    const state = channels.get(channelId);
    if (state === undefined) return;

    state.debounceTimer = null;

    if (state.running) {
      debug?.("dispatcher_debounce_queue", {
        channelId,
        pendingCount: state.pending.length,
        queuedCount: state.queued.length,
      });
      // Handler already running, move pending to queued
      state.queued.push(...state.pending);
      state.pending = [];
      return;
    }

    const trigger = selectNextDispatchTrigger(state.pending);
    const typingWaitMs = getTypingWaitMs(state, state.pending, trigger);
    debug?.("dispatcher_debounce_wait", {
      channelId,
      pendingCount: state.pending.length,
      triggerReason: trigger?.result.reason ?? null,
      triggerMessageId: trigger?.message.id ?? null,
      triggerAuthorId: trigger?.message.authorId ?? null,
      lastTypingAt: trigger !== null ? state.typingByUser.get(trigger.message.authorId) ?? null : null,
      latestMessageAt: trigger !== null ? latestMessageAtForUser(state.pending, trigger.message.authorId) : null,
      typingWaitMs,
    });
    if (typingWaitMs > 0) {
      state.debounceTimer = timers.setTimeout(() => fireDebounce(channelId), typingWaitMs);
      return;
    }

    // Start handler with current pending batch
    const { batch, trigger: dispatchTrigger } = takeNextDispatchBatch(state);
    if (batch.length === 0) {
      resolveDrainIfIdle();
      return;
    }
    state.running = true;
    debug?.("dispatcher_debounce_dispatch", {
      channelId,
      batchIds: batch.map((message) => message.id),
      triggerReason: dispatchTrigger?.result.reason ?? null,
      triggerMessageId: dispatchTrigger?.message.id ?? null,
      triggerAuthorId: dispatchTrigger?.message.authorId ?? null,
    });

    let coveredMessageIds: string[] = [];
    void handler(batch, dispatchTrigger)
      .then((result) => {
        coveredMessageIds = result?.coveredMessageIds ?? [];
      })
      .catch(() => {
        // Handler errors are logged by the handler itself
      })
      .finally(() => {
        state.running = false;
        suppressCoveredMessages(state, coveredMessageIds);

        if (state.queued.length > 0) {
          // Messages arrived during handler execution, start new debounce cycle
          if (state.debounceTimer !== null) {
            timers.clearTimeout(state.debounceTimer);
            state.debounceTimer = null;
          }
          state.pending = [...state.queued, ...state.pending];
          state.queued = [];
        }
        ensurePendingDebounce(channelId, state);
        resolveDrainIfIdle();
      });
  }

  function enqueue(message: unknown, options: EnqueueOptions): boolean {
    if (!accepting) return false;
    const channelId = getChannelId(message);
    const state = getOrCreateState(channelId);
    const messageId = getMessageId(message);
    if (state.suppressedIds.has(messageId)) {
      return false;
    }

    const pending: PendingMessage = {
      id: messageId,
      message,
      receivedAt: timers.now(),
      authorId: options.authorId,
      triggerResult: options.triggerResult,
    };

    const existingTrigger = selectNextDispatchTrigger(state.pending);
    state.pending.push(pending);
    let typingAction = "unchanged";

    const lastTypingAt = state.typingByUser.get(options.authorId);
    if (lastTypingAt !== undefined && lastTypingAt < messageTimestamp(pending)) {
      state.typingByUser.delete(options.authorId);
      typingAction = "cleared_stale";
      if (
        typingWaitEnabled() &&
        existingTrigger !== null &&
        usesTypingWait(existingTrigger.result) &&
        existingTrigger.message.authorId === options.authorId &&
        options.triggerResult === null &&
        messageTimestamp(pending) - lastTypingAt <= triggers.typingIdleMs &&
        triggers.typingResumeGraceMs > 0
      ) {
        state.typingResumeGraceUntilByUser.set(options.authorId, pending.receivedAt + triggers.typingResumeGraceMs);
        typingAction = "resume_grace";
      } else {
        state.typingResumeGraceUntilByUser.delete(options.authorId);
      }
    }
    debug?.("dispatcher_enqueue", {
      channelId,
      messageId,
      authorId: options.authorId,
      triggerReason: options.triggerResult?.reason ?? null,
      pendingCount: state.pending.length,
      messageTimestamp: messageTimestamp(pending),
      receivedAt: pending.receivedAt,
      existingTriggerReason: existingTrigger?.result.reason ?? null,
      existingTriggerMessageId: existingTrigger?.message.id ?? null,
      typingAction,
      lastTypingAt: state.typingByUser.get(options.authorId) ?? null,
      typingResumeGraceUntil: state.typingResumeGraceUntilByUser.get(options.authorId) ?? null,
    });

    // Reset debounce timer
    if (state.debounceTimer !== null) {
      timers.clearTimeout(state.debounceTimer);
    }

    const trigger = selectDispatchTrigger(state.pending);
    state.debounceTimer = timers.setTimeout(
      () => fireDebounce(channelId),
      getDebounceMs(trigger),
    );
    return true;
  }

  function recordTyping(channelId: string, userId: string): void {
    if (!accepting) return;
    const observedAt = timers.now();
    const state = getOrCreateState(channelId);
    state.typingByUser.set(userId, observedAt);
    state.typingResumeGraceUntilByUser.delete(userId);
    debug?.("dispatcher_typing", { channelId, userId, observedAt });
  }

  function drain(): Promise<void> {
    if (drainPromise !== null) return drainPromise;
    accepting = false;
    drainPromise = new Promise<void>((resolve) => {
      resolveDrain = resolve;
    });
    for (const [channelId, state] of channels) {
      if (state.debounceTimer !== null) {
        timers.clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
      }
      if (state.pending.length > 0) fireDebounce(channelId);
    }
    resolveDrainIfIdle();
    return drainPromise;
  }

  function dispose(): void {
    accepting = false;
    for (const [, state] of channels) {
      if (state.debounceTimer !== null) {
        timers.clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
      }
    }
    channels.clear();
    resolveDrainIfIdle();
  }

  return { enqueue, recordTyping, drain, dispose };
}

function triggerPriority(trigger: DispatchTrigger): number {
  switch (trigger.reason) {
    case "scheduled": return 4;
    case "mention": return 3;
    case "keyword": return 2;
    case "random": return 1;
    case "ambient_pickup": return 0;
    case "lingering_attention": return 0;
    case "follow_up": return 0;
    case "ambient_initiative": return 0;
    case "private_life": return 0;
  }
}

function allowsSameAuthorFollowup(trigger: DispatchTrigger): boolean {
  return trigger.reason === "keyword" || trigger.reason === "mention";
}

function usesTypingWait(trigger: DispatchTrigger): boolean {
  return trigger.reason === "keyword" || trigger.reason === "mention";
}
