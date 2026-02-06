import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { wrapToolsWithFollowUp } from "./tool-followup-wrapper";
import { createDatabase, type Database } from "../db/database";
import { unlinkSync } from "fs";

const TEST_DB_PATH = "/tmp/tool-followup-wrapper-test.db";

let db: Database;

beforeEach(() => {
  try { unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
  db = createDatabase(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  try { unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
});

function insertMessage(
  id: string,
  channelId: string,
  userId: string,
  username: string,
  content: string,
  createdAt: number,
  isBot: boolean = false,
): void {
  db.raw
    .prepare(
      `INSERT INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, is_synthetic)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(id, "guild-1", channelId, userId, username, content, content, isBot ? 1 : 0, createdAt);
}

function makeTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "test tool",
    parameters: Type.Object({}),
    execute: () =>
      Promise.resolve({
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      }),
  } as unknown as AgentTool;
}

function makeSendMessageTool(): AgentTool {
  return {
    name: "send_message",
    label: "Send Message",
    description: "test",
    parameters: Type.Object({}),
    execute: () =>
      Promise.resolve({
        content: [{ type: "text" as const, text: "Message sent." }],
        details: { sentMessageId: "bot-msg-1" },
      }),
  } as unknown as AgentTool;
}

const BASE_DEPS = {
  channelId: "ch-1",
  handlerStartTime: 1000,
  botUserId: "bot-1",
  triggerMessageId: "trigger-1",
  maxFollowUps: 5,
};

describe("wrapToolsWithFollowUp", () => {
  test("no annotation when no follow-up messages exist", async () => {
    const tools = [makeTool("some_tool")];
    const { tools: wrapped } = wrapToolsWithFollowUp(tools, { db, ...BASE_DEPS });

    const result = await (wrapped[0] as AgentTool).execute("call-1", {}, undefined);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: "ok" });
  });

  test("lightweight annotation for non-send_message tools", async () => {
    insertMessage("followup-1", "ch-1", "user-1", "alice", "hey there", 2000);

    const tools = [makeTool("search")];
    const { tools: wrapped } = wrapToolsWithFollowUp(tools, { db, ...BASE_DEPS });

    const result = await (wrapped[0] as AgentTool).execute("call-1", {}, undefined);

    expect(result.content).toHaveLength(2);
    const annotation = (result.content[1] as { text: string }).text;
    expect(annotation).toContain("[Channel: 1 new message since you started");
    expect(annotation).toContain("chat_history");
  });

  test("detailed annotation for send_message tool", async () => {
    insertMessage("followup-1", "ch-1", "user-1", "alice", "wait I have more", 2000);

    const tools = [makeSendMessageTool()];
    const { tools: wrapped } = wrapToolsWithFollowUp(tools, { db, ...BASE_DEPS });

    const result = await (wrapped[0] as AgentTool).execute("call-1", {}, undefined);

    expect(result.content.length).toBeGreaterThan(1);
    const annotation = (result.content[result.content.length - 1] as { text: string }).text;
    expect(annotation).toContain("[FOLLOW-UP ACTIVITY");
    expect(annotation).toContain("alice");
    expect(annotation).toContain("wait I have more");
    expect(annotation).toContain("MsgID: followup-1");
    expect(annotation).toContain("reply_to_message_id");
  });

  test("surfacedIds prevents re-surfacing same messages", async () => {
    insertMessage("followup-1", "ch-1", "user-1", "alice", "first", 2000);

    const tools = [makeTool("tool_a"), makeTool("tool_b")];
    const { tools: wrapped } = wrapToolsWithFollowUp(tools, { db, ...BASE_DEPS });

    // First call surfaces the message
    const result1 = await (wrapped[0] as AgentTool).execute("call-1", {}, undefined);
    expect(result1.content).toHaveLength(2);

    // Second call should not re-surface
    const result2 = await (wrapped[1] as AgentTool).execute("call-2", {}, undefined);
    expect(result2.content).toHaveLength(1);
  });

  test("excludes trigger message ID", async () => {
    insertMessage("trigger-1", "ch-1", "user-1", "alice", "trigger msg", 2000);

    const tools = [makeTool("some_tool")];
    const { tools: wrapped } = wrapToolsWithFollowUp(tools, { db, ...BASE_DEPS });

    const result = await (wrapped[0] as AgentTool).execute("call-1", {}, undefined);
    expect(result.content).toHaveLength(1);
  });

  test("excludes bot send IDs", async () => {
    insertMessage("bot-msg-1", "ch-1", "bot-1", "bot", "my response", 2000, true);

    const tools = [makeSendMessageTool()];
    const { tools: wrapped, state: _state } = wrapToolsWithFollowUp(tools, { db, ...BASE_DEPS });

    // send_message auto-registers bot send ID from details.sentMessageId
    const result = await (wrapped[0] as AgentTool).execute("call-1", {}, undefined);

    // bot-msg-1 should be excluded since it's the sentMessageId
    expect(result.content).toHaveLength(1);
  });

  test("registerBotSend excludes IDs from future queries", async () => {
    insertMessage("external-bot-1", "ch-1", "bot-1", "bot", "bot says", 2000, true);

    const tools = [makeTool("some_tool")];
    const { tools: wrapped, state } = wrapToolsWithFollowUp(tools, { db, ...BASE_DEPS });

    state.registerBotSend("external-bot-1");

    const result = await (wrapped[0] as AgentTool).execute("call-1", {}, undefined);
    expect(result.content).toHaveLength(1);
  });

  test("multiple follow-up messages in lightweight annotation show count", async () => {
    insertMessage("f-1", "ch-1", "user-1", "alice", "msg 1", 2000);
    insertMessage("f-2", "ch-1", "user-2", "bob", "msg 2", 3000);
    insertMessage("f-3", "ch-1", "user-1", "alice", "msg 3", 4000);

    const tools = [makeTool("some_tool")];
    const { tools: wrapped } = wrapToolsWithFollowUp(tools, { db, ...BASE_DEPS });

    const result = await (wrapped[0] as AgentTool).execute("call-1", {}, undefined);

    const annotation = (result.content[1] as { text: string }).text;
    expect(annotation).toContain("3 new messages");
  });

  test("new messages arriving between tool calls get surfaced", async () => {
    insertMessage("f-1", "ch-1", "user-1", "alice", "first", 2000);

    const tools = [makeTool("tool_a"), makeTool("tool_b")];
    const { tools: wrapped } = wrapToolsWithFollowUp(tools, { db, ...BASE_DEPS });

    // First call
    await (wrapped[0] as AgentTool).execute("call-1", {}, undefined);

    // New message arrives
    insertMessage("f-2", "ch-1", "user-2", "bob", "second", 5000);

    // Second call should surface the new message
    const result2 = await (wrapped[1] as AgentTool).execute("call-2", {}, undefined);
    expect(result2.content).toHaveLength(2);
  });

  test("messages from other channels are not surfaced", async () => {
    insertMessage("f-1", "ch-2", "user-1", "alice", "wrong channel", 2000);

    const tools = [makeTool("some_tool")];
    const { tools: wrapped } = wrapToolsWithFollowUp(tools, { db, ...BASE_DEPS });

    const result = await (wrapped[0] as AgentTool).execute("call-1", {}, undefined);
    expect(result.content).toHaveLength(1);
  });
});
