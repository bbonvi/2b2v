import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const StartThreadParams = Type.Object({
  name: Type.Optional(
    Type.String({ description: "Thread title. If omitted, defaults to 'Thread'." })
  ),
});

const CloseThreadParams = Type.Object({
  thread_id: Type.Optional(
    Type.String({ description: "Thread id to close. Omit when closing the current thread from inside it." })
  ),
});

export type StartThreadInput = Static<typeof StartThreadParams>;
export type CloseThreadInput = Static<typeof CloseThreadParams>;

/** Details returned from the start_thread tool execution. */
export interface StartThreadDetails {
  threadId: string;
  threadName: string;
  parentChatId: string;
}

/** Details returned from the close_thread tool execution. */
export interface CloseThreadDetails {
  threadId: string;
  threadName: string;
  parentChatId: string;
}

/**
 * Callback that creates the Discord thread.
 * Returns thread metadata on success, throws on failure.
 */
export type ThreadCreator = (name: string) => Promise<{
  threadId: string;
  threadName: string;
  parentChatId: string;
  starterMessageId: string;
}>;

/**
 * Callback that persists the thread record to the database.
 */
export type ThreadPersister = (input: {
  threadId: string;
  guildId: string;
  parentChatId: string;
  starterMessageId: string;
  threadName: string;
}) => void;

/**
 * Callback fired after successful thread creation.
 * Called even if persistThread fails (thread exists in Discord).
 */
export type ThreadSuccessCallback = (payload: {
  threadId: string;
  threadName: string;
  parentChatId: string;
}) => void;

/** Metadata lookup used by close_thread to enforce bot-created ownership. */
export type ThreadMetadataLookup = (threadId: string) => {
  threadId: string;
  guildId: string;
  threadName: string;
  parentChatId: string;
  createdByBot: boolean;
} | null;

/** Callback that archives a Discord thread and returns its final metadata. */
export type ThreadCloser = (threadId: string) => Promise<{
  threadId: string;
  threadName: string;
  parentChatId: string;
}>;

/** Callback that persists local archived state after Discord closes a thread. */
export type ThreadArchivePersister = (threadId: string) => void;

/** Callback fired when thread persistence fails after Discord created the thread. */
export type ThreadPersistErrorCallback = (error: unknown) => void;

/** Dependencies for the start_thread tool. */
export interface StartThreadToolDeps {
  guildId: string;
  createThread: ThreadCreator;
  persistThread: ThreadPersister;
  /** Optional callback fired after successful thread creation. */
  onSuccess?: ThreadSuccessCallback;
  /** Optional callback for reporting persistence failures. */
  onPersistError?: ThreadPersistErrorCallback;
}

/** Dependencies for the close_thread tool. */
export interface CloseThreadToolDeps {
  currentGuildId: string;
  currentChannelId: string;
  currentIsThread: boolean;
  lookupThread: ThreadMetadataLookup;
  closeThread: ThreadCloser;
  persistArchived: ThreadArchivePersister;
}

/**
 * Create the start_thread AgentTool.
 * Creates a public, message-attached thread on the trigger message.
 */
export function createStartThreadTool(deps: StartThreadToolDeps): AgentTool {
  const { guildId, createThread, persistThread, onSuccess, onPersistError } = deps;

  return {
    name: "start_thread",
    label: "Start Thread",
    description:
      "Create a new thread attached to the trigger message. Use when the final answer should continue in a separate thread (long discussions or to avoid cluttering the main chat). Runtime sends your final answer to the created thread.",
    parameters: StartThreadParams,
    execute: async (
      _toolCallId,
      params
    ): Promise<AgentToolResult<StartThreadDetails | { error: string }>> => {
      const p = params as StartThreadInput;
      const threadName = p.name ?? "Thread";

      let result: Awaited<ReturnType<ThreadCreator>>;
      try {
        result = await createThread(threadName);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to create thread: ${message}` }],
          details: { error: message },
        };
      }

      // Persist thread record (bot_participating starts false, set true after first bot message)
      try {
        persistThread({
          threadId: result.threadId,
          guildId,
          parentChatId: result.parentChatId,
          starterMessageId: result.starterMessageId,
          threadName: result.threadName,
        });
      } catch (err) {
        // Thread created in Discord but failed to persist — continue anyway
        // The thread exists, so return success (can be recovered later)
        onPersistError?.(err);
      }

      // Fire success callback (e.g., insert synthetic event in parent chat)
      // Called even if persist failed since thread exists in Discord
      if (onSuccess !== undefined) {
        onSuccess({
          threadId: result.threadId,
          threadName: result.threadName,
          parentChatId: result.parentChatId,
        });
      }

      return {
        content: [
          {
            type: "text",
            text: `Thread created: "${result.threadName}" (thread_id: ${result.threadId}, parent_chat_id: ${result.parentChatId}). Runtime will send the final answer to this thread.`,
          },
        ],
        details: {
          threadId: result.threadId,
          threadName: result.threadName,
          parentChatId: result.parentChatId,
        },
      };
    },
  };
}

/**
 * Create the close_thread AgentTool.
 * Only bot-created threads known to local metadata can be archived.
 */
export function createCloseThreadTool(deps: CloseThreadToolDeps): AgentTool {
  return {
    name: "close_thread",
    label: "Close Thread",
    description:
      "Archive a bot-created Discord thread. Omit thread_id from inside the thread; from a parent channel provide a visible thread_id. Use only after checking context/history enough to avoid closing a side thread for an unrelated bystander.",
    parameters: CloseThreadParams,
    execute: async (
      _toolCallId,
      params
    ): Promise<AgentToolResult<CloseThreadDetails | { error: string }>> => {
      const p = params as CloseThreadInput;
      const trimmedThreadId = p.thread_id?.trim();
      const threadId = trimmedThreadId !== undefined && trimmedThreadId !== ""
        ? trimmedThreadId
        : deps.currentChannelId;
      const metadata = deps.lookupThread(threadId);
      if (metadata === null) {
        return {
          content: [{ type: "text", text: `Cannot close thread ${threadId}: it is not a known bot-created thread.` }],
          details: { error: "unknown_thread" },
        };
      }
      if (!metadata.createdByBot) {
        return {
          content: [{ type: "text", text: `Cannot close thread ${threadId}: it was not created by this bot.` }],
          details: { error: "not_bot_created" },
        };
      }
      if (metadata.guildId !== deps.currentGuildId) {
        return {
          content: [{ type: "text", text: `Cannot close thread ${threadId}: it is not in the current guild.` }],
          details: { error: "wrong_guild" },
        };
      }
      if (deps.currentIsThread) {
        if (threadId !== deps.currentChannelId) {
          return {
            content: [{ type: "text", text: `Cannot close thread ${threadId}: only the current thread can be closed from inside a thread.` }],
            details: { error: "not_current_thread" },
          };
        }
      } else if (metadata.parentChatId !== deps.currentChannelId) {
        return {
          content: [{ type: "text", text: `Cannot close thread ${threadId}: it is not attached to the current parent channel.` }],
          details: { error: "not_visible_in_parent" },
        };
      }

      let result: Awaited<ReturnType<ThreadCloser>>;
      try {
        result = await deps.closeThread(threadId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to close thread ${threadId}: ${message}` }],
          details: { error: message },
        };
      }

      deps.persistArchived(threadId);
      return {
        content: [{
          type: "text",
          text: `Thread closed: "${result.threadName}" (thread_id: ${result.threadId}, parent_chat_id: ${result.parentChatId}).`,
        }],
        details: {
          threadId: result.threadId,
          threadName: result.threadName,
          parentChatId: result.parentChatId,
        },
      };
    },
  };
}
