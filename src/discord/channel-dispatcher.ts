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

const MAX_SUPPRESSED_IDS = 1000;

interface ChannelState {
  pending: PendingMessage[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  queued: PendingMessage[];
  suppressedIds: Set<string>;
  suppressedOrder: string[];
  typingByUser: Map<string, number>;
}

export interface ChannelDispatcher {
  /** Enqueue a message for processing. Returns immediately. */
  enqueue(message: unknown, options: EnqueueOptions): void;
  /** Record a typing start event for a user in a channel. */
  recordTyping(channelId: string, userId: string): void;
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
    for (let i = batch.length - 1; i >= 0; i--) {
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
  const selectedIndex = batch.findIndex((message) => message.id === selected.id);
  if (triggerIndex === -1 || selectedIndex === -1) return [selected];

  return batch
    .slice(Math.min(triggerIndex, selectedIndex), Math.max(triggerIndex, selectedIndex) + 1)
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

  let endIndex = triggerIndex;
  if (allowsSameAuthorFollowup(trigger.result)) {
    for (let i = triggerIndex + 1; i < state.pending.length; i += 1) {
      const message = state.pending[i];
      if (message === undefined || message.triggerResult !== null) break;
      if (message.authorId === trigger.message.authorId) endIndex = i;
    }
  }

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
}): ChannelDispatcher {
  const { config, triggers, handler } = opts;
  const channels = new Map<string, ChannelState>();

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

  function latestMessageAtForUser(messages: readonly PendingMessage[], userId: string): number {
    let latest = 0;
    for (const message of messages) {
      if (message.authorId === userId) latest = Math.max(latest, message.receivedAt);
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
    if (lastTypingAt === undefined) return 0;

    const latestMessageAt = latestMessageAtForUser(messages, userId);
    if (lastTypingAt < latestMessageAt) {
      state.typingByUser.delete(userId);
      return 0;
    }

    const now = Date.now();
    const idleReadyAt = lastTypingAt + triggers.typingIdleMs;
    const maxReadyAt = trigger.message.receivedAt + triggers.typingMaxWaitMs;
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
    const trigger = selectDispatchTrigger(state.pending);
    state.debounceTimer = setTimeout(
      () => fireDebounce(channelId),
      getDebounceMs(trigger),
    );
  }

  function fireDebounce(channelId: string): void {
    const state = channels.get(channelId);
    if (state === undefined) return;

    state.debounceTimer = null;

    if (state.running) {
      // Handler already running, move pending to queued
      state.queued.push(...state.pending);
      state.pending = [];
      return;
    }

    const trigger = selectNextDispatchTrigger(state.pending);
    const typingWaitMs = getTypingWaitMs(state, state.pending, trigger);
    if (typingWaitMs > 0) {
      state.debounceTimer = setTimeout(() => fireDebounce(channelId), typingWaitMs);
      return;
    }

    // Start handler with current pending batch
    const { batch, trigger: dispatchTrigger } = takeNextDispatchBatch(state);
    if (batch.length === 0) return;
    state.running = true;

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
            clearTimeout(state.debounceTimer);
            state.debounceTimer = null;
          }
          state.pending = [...state.queued, ...state.pending];
          state.queued = [];
        }
        ensurePendingDebounce(channelId, state);
      });
  }

  function enqueue(message: unknown, options: EnqueueOptions): void {
    const channelId = getChannelId(message);
    const state = getOrCreateState(channelId);
    const messageId = getMessageId(message);
    if (state.suppressedIds.has(messageId)) {
      return;
    }

    const pending: PendingMessage = {
      id: messageId,
      message,
      receivedAt: Date.now(),
      authorId: options.authorId,
      triggerResult: options.triggerResult,
    };

    const existingTrigger = selectNextDispatchTrigger(state.pending);
    state.pending.push(pending);

    if (
      typingWaitEnabled() &&
      existingTrigger !== null &&
      usesTypingWait(existingTrigger.result) &&
      allowsSameAuthorFollowup(existingTrigger.result) &&
      existingTrigger.message.authorId === options.authorId &&
      options.triggerResult === null
    ) {
      state.typingByUser.set(options.authorId, pending.receivedAt);
    } else {
      state.typingByUser.delete(options.authorId);
    }

    // Reset debounce timer
    if (state.debounceTimer !== null) {
      clearTimeout(state.debounceTimer);
    }

    const trigger = selectDispatchTrigger(state.pending);
    state.debounceTimer = setTimeout(
      () => fireDebounce(channelId),
      getDebounceMs(trigger),
    );
  }

  function recordTyping(channelId: string, userId: string): void {
    const state = channels.get(channelId);
    if (state === undefined) return;
    const messages = [...state.queued, ...state.pending];
    const trigger = selectNextDispatchTrigger(messages);
    if (trigger === null || !usesTypingWait(trigger.result)) return;
    if (trigger.message.authorId !== userId) return;

    const observedAt = Date.now();
    const latestMessageAt = latestMessageAtForUser(messages, userId);
    if (observedAt <= latestMessageAt) return;
    state.typingByUser.set(userId, observedAt);
  }

  function dispose(): void {
    for (const [, state] of channels) {
      if (state.debounceTimer !== null) {
        clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
      }
    }
    channels.clear();
  }

  return { enqueue, recordTyping, dispose };
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
  }
}

function allowsSameAuthorFollowup(trigger: DispatchTrigger): boolean {
  return trigger.reason === "keyword" || trigger.reason === "mention";
}

function usesTypingWait(trigger: DispatchTrigger): boolean {
  return trigger.reason === "keyword" || trigger.reason === "mention";
}
