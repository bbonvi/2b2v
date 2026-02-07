import type { DispatcherConfig } from "../config/types";

/** A pending message waiting to be dispatched. */
export interface PendingMessage {
  /** Discord message ID. */
  id: string;
  /** The discord.js Message object. */
  message: unknown;
  /** Date.now() when enqueue() fired. */
  receivedAt: number;
  /** Whether the bot is mentioned in this message. */
  isMention: boolean;
}

export interface DispatchOutcome {
  /**
   * Message IDs that were already surfaced to the agent context/tool results
   * during the current run and should not be replayed as separate runs.
   */
  coveredMessageIds?: string[];
}

/** Handler function that the dispatcher calls with accumulated messages. */
export type DispatchHandler = (messages: PendingMessage[]) => Promise<DispatchOutcome | undefined>;

const MAX_SUPPRESSED_IDS = 1000;

interface ChannelState {
  pending: PendingMessage[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Whether the current debounce was set for a mention (shorter delay). */
  debounceIsMention: boolean;
  running: boolean;
  queued: PendingMessage[];
  suppressedIds: Set<string>;
  suppressedOrder: string[];
}

export interface ChannelDispatcher {
  /** Enqueue a message for processing. Returns immediately. */
  enqueue(message: unknown, isMention: boolean): void;
  /** Shut down all timers and pending state. */
  dispose(): void;
}

/**
 * Create a channel dispatcher that debounces and serializes handler execution
 * per channel. Prevents duplicate responses when multiple messages arrive
 * during processing.
 */
export function createChannelDispatcher(opts: {
  config: DispatcherConfig;
  handler: DispatchHandler;
}): ChannelDispatcher {
  const { config, handler } = opts;
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
        debounceIsMention: false,
        running: false,
        queued: [],
        suppressedIds: new Set<string>(),
        suppressedOrder: [],
      };
      channels.set(channelId, state);
    }
    return state;
  }

  function getDebounceMs(isMention: boolean): number {
    return isMention ? config.mentionDebounceMs : config.defaultDebounceMs;
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

    // Start handler with current pending batch
    const batch = state.pending;
    state.pending = [];
    state.running = true;

    let coveredMessageIds: string[] = [];
    void handler(batch)
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
          state.pending = state.queued;
          state.queued = [];
          const hasMention = state.pending.some((m) => m.isMention);
          state.debounceIsMention = hasMention;
          state.debounceTimer = setTimeout(
            () => fireDebounce(channelId),
            getDebounceMs(hasMention),
          );
        }
      });
  }

  function enqueue(message: unknown, isMention: boolean): void {
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
      isMention,
    };

    state.pending.push(pending);

    // If mention arrives and current timer is for non-mention, shorten debounce
    if (isMention && !state.debounceIsMention && state.debounceTimer !== null) {
      clearTimeout(state.debounceTimer);
      state.debounceIsMention = true;
      state.debounceTimer = setTimeout(
        () => fireDebounce(channelId),
        getDebounceMs(true),
      );
      return;
    }

    // Reset debounce timer
    if (state.debounceTimer !== null) {
      clearTimeout(state.debounceTimer);
    }

    state.debounceIsMention = isMention || state.debounceIsMention;
    state.debounceTimer = setTimeout(
      () => fireDebounce(channelId),
      getDebounceMs(state.debounceIsMention),
    );
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

  return { enqueue, dispose };
}
