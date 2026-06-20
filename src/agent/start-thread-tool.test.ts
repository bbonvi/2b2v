import { test, expect, describe, mock } from "bun:test";
import {
  createCloseThreadTool,
  createStartThreadTool,
  type CloseThreadDetails,
  type StartThreadToolDeps,
  type StartThreadDetails,
} from "./start-thread-tool";
import type { TextContent } from "@mariozechner/pi-ai";

interface PersistedThread {
  threadId: string;
  guildId: string;
  parentChatId: string;
  starterMessageId: string;
  threadName: string;
}

function makeDeps(overrides: Partial<StartThreadToolDeps> = {}): StartThreadToolDeps & { persisted: PersistedThread[] } {
  const persisted: PersistedThread[] = [];
  return {
    guildId: "g1",
    createThread: (name: string) => Promise.resolve({
      threadId: "thread-123",
      threadName: name,
      parentChatId: "channel-456",
      starterMessageId: "msg-789",
    }),
    persistThread: (input) => {
      persisted.push(input);
    },
    persisted,
    ...overrides,
  };
}

describe("createStartThreadTool", () => {
  test("returns start_thread AgentTool with correct metadata", () => {
    const deps = makeDeps();
    const tool = createStartThreadTool(deps);
    expect(tool.name).toBe("start_thread");
    expect(tool.label).toBe("Start Thread");
    expect(tool.description).toBeDefined();
    expect(tool.parameters).toBeDefined();
  });

  test("creates thread with provided name", async () => {
    const deps = makeDeps();
    const tool = createStartThreadTool(deps);
    const result = await tool.execute("tc1", { name: "Discussion Topic" }, AbortSignal.timeout(5000));

    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("Discussion Topic");
    expect(text).toContain("thread_id: thread-123");

    const details = result.details as StartThreadDetails;
    expect(details.threadId).toBe("thread-123");
    expect(details.threadName).toBe("Discussion Topic");
    expect(details.parentChatId).toBe("channel-456");
  });

  test("defaults thread name to 'Thread' when not provided", async () => {
    let capturedName: string | undefined;
    const deps = makeDeps({
      createThread: (name) => {
        capturedName = name;
        return Promise.resolve({
          threadId: "thread-123",
          threadName: name,
          parentChatId: "channel-456",
          starterMessageId: "msg-789",
        });
      },
    });
    const tool = createStartThreadTool(deps);
    await tool.execute("tc1", {}, AbortSignal.timeout(5000));

    expect(capturedName).toBe("Thread");
  });

  test("persists thread record on success", async () => {
    const deps = makeDeps();
    const tool = createStartThreadTool(deps);
    await tool.execute("tc1", { name: "Test Thread" }, AbortSignal.timeout(5000));

    expect(deps.persisted).toHaveLength(1);
    expect(deps.persisted[0]).toEqual({
      threadId: "thread-123",
      guildId: "g1",
      parentChatId: "channel-456",
      starterMessageId: "msg-789",
      threadName: "Test Thread",
    });
  });

  test("returns error when createThread fails", async () => {
    const deps = makeDeps({
      createThread: () => Promise.reject(new Error("Missing Permissions")),
    });
    const tool = createStartThreadTool(deps);
    const result = await tool.execute("tc1", { name: "Test" }, AbortSignal.timeout(5000));

    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("Failed to create thread");
    expect(text).toContain("Missing Permissions");

    const details = result.details as { error: string };
    expect(details.error).toBe("Missing Permissions");
  });

  test("does not persist thread when createThread fails", async () => {
    const deps = makeDeps({
      createThread: () => Promise.reject(new Error("API Error")),
    });
    const tool = createStartThreadTool(deps);
    await tool.execute("tc1", { name: "Test" }, AbortSignal.timeout(5000));

    expect(deps.persisted).toHaveLength(0);
  });

  test("returns success even if persist fails (thread exists in Discord)", async () => {
    const onPersistError = mock(() => {});
    const deps = makeDeps({
      persistThread: () => {
        throw new Error("DB Error");
      },
      onPersistError,
    });
    const tool = createStartThreadTool(deps);
    const result = await tool.execute("tc1", { name: "Test" }, AbortSignal.timeout(5000));

    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("Thread created");

    const details = result.details as StartThreadDetails;
    expect(details.threadId).toBe("thread-123");
    expect(onPersistError).toHaveBeenCalledTimes(1);
  });

  test("includes runtime routing hint and parent_chat_id in response", async () => {
    const deps = makeDeps();
    const tool = createStartThreadTool(deps);
    const result = await tool.execute("tc1", { name: "Test" }, AbortSignal.timeout(5000));

    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("Runtime will send the final answer to this thread.");
    expect(text).toContain("parent_chat_id: channel-456");
  });

  test("calls onSuccess callback after successful creation and persistence", async () => {
    let successPayload: { threadId: string; threadName: string; parentChatId: string } | undefined;
    const deps = makeDeps({
      onSuccess: (payload) => {
        successPayload = payload;
      },
    });
    const tool = createStartThreadTool(deps);
    await tool.execute("tc1", { name: "My Thread" }, AbortSignal.timeout(5000));

    expect(successPayload).toBeDefined();
    expect(successPayload?.threadId).toBe("thread-123");
    expect(successPayload?.threadName).toBe("My Thread");
    expect(successPayload?.parentChatId).toBe("channel-456");
  });

  test("does not call onSuccess when createThread fails", async () => {
    let onSuccessCalled = false;
    const deps = makeDeps({
      createThread: () => Promise.reject(new Error("API Error")),
      onSuccess: () => {
        onSuccessCalled = true;
      },
    });
    const tool = createStartThreadTool(deps);
    await tool.execute("tc1", { name: "Test" }, AbortSignal.timeout(5000));

    expect(onSuccessCalled).toBe(false);
  });

  test("still calls onSuccess when persistThread fails (thread exists)", async () => {
    let successPayload: { threadId: string; threadName: string; parentChatId: string } | undefined;
    const onPersistError = mock(() => {});
    const deps = makeDeps({
      persistThread: () => {
        throw new Error("DB Error");
      },
      onSuccess: (payload) => {
        successPayload = payload;
      },
      onPersistError,
    });
    const tool = createStartThreadTool(deps);
    await tool.execute("tc1", { name: "My Thread" }, AbortSignal.timeout(5000));

    // Even though persist failed, onSuccess should fire since thread exists in Discord
    expect(successPayload).toBeDefined();
    expect(successPayload?.threadId).toBe("thread-123");
    expect(onPersistError).toHaveBeenCalledTimes(1);
  });

  test("works without onSuccess callback (backward compatible)", async () => {
    const deps = makeDeps();
    // No onSuccess provided
    const tool = createStartThreadTool(deps);
    const result = await tool.execute("tc1", { name: "Test" }, AbortSignal.timeout(5000));

    // Should not throw
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("Thread created");
  });
});

describe("createCloseThreadTool", () => {
  test("closes a known bot-created thread", async () => {
    const archived: string[] = [];
    const tool = createCloseThreadTool({
      currentGuildId: "g1",
      currentChannelId: "thread-123",
      currentIsThread: true,
      lookupThread: (threadId) => threadId === "thread-123"
        ? { threadId, guildId: "g1", threadName: "Thread", parentChatId: "channel-456", createdByBot: true }
        : null,
      closeThread: (threadId) => Promise.resolve({
        threadId,
        threadName: "Thread",
        parentChatId: "channel-456",
      }),
      persistArchived: (threadId) => {
        archived.push(threadId);
      },
    });

    const result = await tool.execute("tc1", {}, AbortSignal.timeout(5000));
    const details = result.details as CloseThreadDetails;
    expect(details.threadId).toBe("thread-123");
    expect(archived).toEqual(["thread-123"]);
  });

  test("refuses non-bot-created threads", async () => {
    const tool = createCloseThreadTool({
      currentGuildId: "g1",
      currentChannelId: "thread-123",
      currentIsThread: true,
      lookupThread: (threadId) => ({ threadId, guildId: "g1", threadName: "Thread", parentChatId: "channel-456", createdByBot: false }),
      closeThread: () => Promise.reject(new Error("should not run")),
      persistArchived: () => {},
    });

    const result = await tool.execute("tc1", { thread_id: "thread-123" }, AbortSignal.timeout(5000));
    expect((result.details as { error: string }).error).toBe("not_bot_created");
  });

  test("uses explicit thread_id from parent channel", async () => {
    let closed: string | undefined;
    const tool = createCloseThreadTool({
      currentGuildId: "g1",
      currentChannelId: "parent-1",
      currentIsThread: false,
      lookupThread: (threadId) => ({ threadId, guildId: "g1", threadName: "Thread", parentChatId: "parent-1", createdByBot: true }),
      closeThread: (threadId) => {
        closed = threadId;
        return Promise.resolve({ threadId, threadName: "Thread", parentChatId: "parent-1" });
      },
      persistArchived: () => {},
    });

    await tool.execute("tc1", { thread_id: "thread-456" }, AbortSignal.timeout(5000));
    expect(closed).toBe("thread-456");
  });

  test("trims explicit thread_id before closing", async () => {
    let closed: string | undefined;
    const tool = createCloseThreadTool({
      currentGuildId: "g1",
      currentChannelId: "parent-1",
      currentIsThread: false,
      lookupThread: (threadId) => threadId === "thread-456"
        ? { threadId, guildId: "g1", threadName: "Thread", parentChatId: "parent-1", createdByBot: true }
        : null,
      closeThread: (threadId) => {
        closed = threadId;
        return Promise.resolve({ threadId, threadName: "Thread", parentChatId: "parent-1" });
      },
      persistArchived: () => {},
    });

    await tool.execute("tc1", { thread_id: " thread-456 " }, AbortSignal.timeout(5000));
    expect(closed).toBe("thread-456");
  });

  test("refuses a bot-created thread outside the current parent channel", async () => {
    const tool = createCloseThreadTool({
      currentGuildId: "g1",
      currentChannelId: "parent-1",
      currentIsThread: false,
      lookupThread: (threadId) => ({ threadId, guildId: "g1", threadName: "Thread", parentChatId: "parent-2", createdByBot: true }),
      closeThread: () => Promise.reject(new Error("should not run")),
      persistArchived: () => {},
    });

    const result = await tool.execute("tc1", { thread_id: "thread-456" }, AbortSignal.timeout(5000));
    expect((result.details as { error: string }).error).toBe("not_visible_in_parent");
  });
});
