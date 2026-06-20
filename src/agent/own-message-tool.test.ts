import { describe, expect, test } from "bun:test";
import type { TextContent } from "@mariozechner/pi-ai";
import {
  authorizeOwnMessageOperation,
  createOwnMessageTools,
  type OwnMessageLookup,
  type OwnMessageToolsDeps,
} from "./own-message-tool";

const botMessage: OwnMessageLookup = {
  id: "m-bot",
  guildId: "g1",
  channelId: "c1",
  authorId: "bot-1",
  authorUsername: "2b",
  content: "old",
  createdAt: 123,
  replyToId: "user-msg",
};

function textOf(result: Awaited<ReturnType<ReturnType<typeof createOwnMessageTools>[number]["execute"]>>): string {
  return (result.content[0] as TextContent).text;
}

function makeDeps(overrides: Partial<OwnMessageToolsDeps> = {}): OwnMessageToolsDeps & {
  edited: string[];
  deleted: string[];
  editStates: unknown[];
  deleteStates: unknown[];
} {
  const edited: string[] = [];
  const deleted: string[] = [];
  const editStates: unknown[] = [];
  const deleteStates: unknown[] = [];
  return {
    currentChannelId: "c1",
    botUserId: "bot-1",
    fetchMessage: (_channelId, messageId) => Promise.resolve(messageId === botMessage.id ? botMessage : null),
    editMessage: (_channelId, _messageId, content) => {
      edited.push(content);
      return Promise.resolve({ rawContent: content });
    },
    deleteMessage: (_channelId, messageId) => {
      deleted.push(messageId);
      return Promise.resolve();
    },
    afterEdit: (input) => {
      editStates.push(input);
      return Promise.resolve();
    },
    afterDelete: (input) => {
      deleteStates.push(input);
      return Promise.resolve();
    },
    edited,
    deleted,
    editStates,
    deleteStates,
    ...overrides,
  };
}

describe("authorizeOwnMessageOperation", () => {
  test("defaults to the current channel and authorizes bot-authored guild messages", async () => {
    const deps = makeDeps();
    const result = await authorizeOwnMessageOperation(deps, { messageId: "m-bot" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.channelId).toBe("c1");
    expect(result.value.message.id).toBe("m-bot");
  });

  test("rejects user-authored messages", async () => {
    const deps = makeDeps({
      fetchMessage: () => Promise.resolve({ ...botMessage, authorId: "user-1" }),
    });
    const result = await authorizeOwnMessageOperation(deps, { messageId: "m-user" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("not_own_message");
  });

  test("rejects DMs", async () => {
    const deps = makeDeps({
      fetchMessage: () => Promise.resolve({ ...botMessage, guildId: null }),
    });
    const result = await authorizeOwnMessageOperation(deps, { messageId: "m-dm" });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("dm_not_supported");
  });
});

describe("createOwnMessageTools", () => {
  test("edit_own_message edits Discord first and syncs local state metadata", async () => {
    const deps = makeDeps();
    const [editTool] = createOwnMessageTools(deps);
    if (editTool === undefined) throw new Error("missing edit tool");

    const result = await editTool.execute("tc1", {
      message_id: "m-bot",
      content: "corrected",
    }, AbortSignal.timeout(5000));

    expect(textOf(result)).toContain("Edited own message m-bot");
    expect(deps.edited).toEqual(["corrected"]);
    expect(deps.editStates).toEqual([{
      messageId: "m-bot",
      guildId: "g1",
      channelId: "c1",
      botUserId: "bot-1",
      botUsername: "2b",
      rawContent: "corrected",
      translatedContent: "corrected",
      createdAt: 123,
      replyToId: "user-msg",
    }]);
  });

  test("delete_own_message deletes Discord first and syncs local state", async () => {
    const deps = makeDeps();
    const [, deleteTool] = createOwnMessageTools(deps);
    if (deleteTool === undefined) throw new Error("missing delete tool");

    const result = await deleteTool.execute("tc1", {
      message_id: "m-bot",
    }, AbortSignal.timeout(5000));

    expect(textOf(result)).toContain("Deleted own message m-bot");
    expect(deps.deleted).toEqual(["m-bot"]);
    expect(deps.deleteStates).toEqual([{
      messageId: "m-bot",
      guildId: "g1",
      channelId: "c1",
    }]);
  });

  test("does not call mutators for non-bot-authored messages", async () => {
    const deps = makeDeps({
      fetchMessage: () => Promise.resolve({ ...botMessage, authorId: "user-1" }),
    });
    const [editTool, deleteTool] = createOwnMessageTools(deps);
    if (editTool === undefined || deleteTool === undefined) throw new Error("missing tools");

    const editResult = await editTool.execute("tc1", {
      message_id: "m-user",
      content: "nope",
    }, AbortSignal.timeout(5000));
    const deleteResult = await deleteTool.execute("tc1", {
      message_id: "m-user",
    }, AbortSignal.timeout(5000));

    expect(textOf(editResult)).toContain("not authored by this bot");
    expect(textOf(deleteResult)).toContain("not authored by this bot");
    expect(deps.edited).toEqual([]);
    expect(deps.deleted).toEqual([]);
    expect(deps.editStates).toEqual([]);
    expect(deps.deleteStates).toEqual([]);
  });
});
