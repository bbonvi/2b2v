import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const StartThreadParams = Type.Object({
  name: Type.Optional(
    Type.String({ description: "Thread title. If omitted, defaults to 'Thread'." })
  ),
});

export type StartThreadInput = Static<typeof StartThreadParams>;

/** Details returned from the start_thread tool execution. */
export interface StartThreadDetails {
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

/** Dependencies for the start_thread tool. */
export interface StartThreadToolDeps {
  guildId: string;
  createThread: ThreadCreator;
  persistThread: ThreadPersister;
  /** Optional callback fired after successful thread creation. */
  onSuccess?: ThreadSuccessCallback;
}

/**
 * Create the start_thread AgentTool.
 * Creates a public, message-attached thread on the trigger message.
 */
export function createStartThreadTool(deps: StartThreadToolDeps): AgentTool {
  const { guildId, createThread, persistThread, onSuccess } = deps;

  return {
    name: "start_thread",
    label: "Start Thread",
    description:
      "Create a new thread attached to the trigger message. Use when you want to continue a conversation in a separate thread (e.g., for long discussions, private topics, or to avoid cluttering the main chat). Returns the thread_id for use with persona_turn(chat_id).",
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
        // TODO: inject logger via deps instead of console.error
        console.error("Failed to persist thread record:", err);
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
            text: `Thread created: "${result.threadName}" (thread_id: ${result.threadId}, parent_chat_id: ${result.parentChatId}). Use persona_turn(chat_id="${result.threadId}") to post in the thread.`,
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
