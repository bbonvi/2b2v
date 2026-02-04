import { test, expect, describe } from "bun:test";
import {
  createStartThreadTool,
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
    const deps = makeDeps({
      persistThread: () => {
        throw new Error("DB Error");
      },
    });
    const tool = createStartThreadTool(deps);
    const result = await tool.execute("tc1", { name: "Test" }, AbortSignal.timeout(5000));

    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("Thread created");

    const details = result.details as StartThreadDetails;
    expect(details.threadId).toBe("thread-123");
  });

  test("includes chat_id usage hint in response", async () => {
    const deps = makeDeps();
    const tool = createStartThreadTool(deps);
    const result = await tool.execute("tc1", { name: "Test" }, AbortSignal.timeout(5000));

    const text = (result.content[0] as TextContent).text;
    expect(text).toContain('send_message(chat_id="thread-123")');
  });
});
