import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "../db/database.ts";
import {
  createInnerThread,
  deleteInnerThread,
  getInnerThread,
  listApplicableInnerThreads,
  listInnerThreads,
  updateInnerThread,
  type InnerThread,
  type InnerThreadAbout,
  type InnerThreadPatch,
  type InnerThreadRecallMode,
  type InnerThreadRecallScope,
} from "../db/inner-thread-repository.ts";

const AboutParams = Type.Object({
  type: Type.Union([Type.Literal("self"), Type.Literal("community"), Type.Literal("user")]),
  user_id: Type.Optional(Type.String()),
});

const RecallParams = Type.Object({
  scope: Type.Union([Type.Literal("anywhere"), Type.Literal("guild")]),
  guild_id: Type.Optional(Type.String()),
  mode: Type.Union([Type.Literal("always"), Type.Literal("users")]),
  user_ids: Type.Optional(Type.Array(Type.String())),
});

const ThreadFields = {
  content: Type.String({ minLength: 1 }),
  about: AboutParams,
  recall: RecallParams,
  salience: Type.Number({ minimum: 0, maximum: 1 }),
  pressure: Type.Number({ minimum: 0, maximum: 1 }),
  source_message_ids: Type.Optional(Type.Array(Type.String())),
  expires_at: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
};

const RecordInnerThreadsParams = Type.Object({
  actions: Type.Array(Type.Union([
    Type.Object({
      action: Type.Literal("create"),
      ...ThreadFields,
    }),
    Type.Object({
      action: Type.Literal("update"),
      id: Type.String(),
      content: Type.Optional(ThreadFields.content),
      about: Type.Optional(AboutParams),
      recall: Type.Optional(RecallParams),
      salience: Type.Optional(ThreadFields.salience),
      pressure: Type.Optional(ThreadFields.pressure),
      source_message_ids: Type.Optional(Type.Array(Type.String())),
      expires_at: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    }),
    Type.Object({
      action: Type.Literal("resolve"),
      id: Type.String(),
      pressure: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    }),
    Type.Object({
      action: Type.Literal("delete"),
      id: Type.String(),
    }),
  ]), { minItems: 1, maxItems: 20 }),
});

type AboutInput = { type: InnerThreadAbout; user_id?: string };
type RecallInput = {
  scope: InnerThreadRecallScope;
  guild_id?: string;
  mode: InnerThreadRecallMode;
  user_ids?: string[];
};
type CreateAction = {
  action: "create";
  content: string;
  about: AboutInput;
  recall: RecallInput;
  salience: number;
  pressure: number;
  source_message_ids?: string[];
  expires_at?: number | null;
};
type UpdateAction = {
  action: "update";
  id: string;
  content?: string;
  about?: AboutInput;
  recall?: RecallInput;
  salience?: number;
  pressure?: number;
  source_message_ids?: string[];
  expires_at?: number | null;
};
type ResolveAction = { action: "resolve"; id: string; pressure?: number };
type DeleteAction = { action: "delete"; id: string };
type ThreadAction = CreateAction | UpdateAction | ResolveAction | DeleteAction;

function validateAbout(about: AboutInput): string | null {
  if (about.type === "user" && (about.user_id === undefined || about.user_id.trim() === "")) {
    return "about.user_id is required when about.type is user.";
  }
  if (about.type !== "user" && about.user_id !== undefined) {
    return "about.user_id is only valid when about.type is user.";
  }
  return null;
}

function validateRecall(recall: RecallInput): string | null {
  if (recall.scope === "guild" && (recall.guild_id === undefined || recall.guild_id.trim() === "")) {
    return "recall.guild_id is required for guild scope.";
  }
  if (recall.scope === "anywhere" && recall.guild_id !== undefined) {
    return "recall.guild_id is only valid for guild scope.";
  }
  if (recall.mode === "users" && (recall.user_ids === undefined || recall.user_ids.length === 0)) {
    return "recall.user_ids is required when recall.mode is users.";
  }
  return null;
}

function patchFromAction(action: UpdateAction): InnerThreadPatch {
  return {
    ...(action.content !== undefined ? { content: action.content } : {}),
    ...(action.about !== undefined ? {
      aboutType: action.about.type,
      aboutUserId: action.about.type === "user" ? action.about.user_id ?? null : null,
    } : {}),
    ...(action.recall !== undefined ? {
      recallScope: action.recall.scope,
      recallGuildId: action.recall.scope === "guild" ? action.recall.guild_id ?? null : null,
      recallMode: action.recall.mode,
      recallUserIds: action.recall.mode === "users" ? action.recall.user_ids ?? [] : [],
    } : {}),
    ...(action.salience !== undefined ? { salience: action.salience } : {}),
    ...(action.pressure !== undefined ? { pressure: action.pressure } : {}),
    ...(action.source_message_ids !== undefined ? { sourceMessageIds: action.source_message_ids } : {}),
    ...(action.expires_at !== undefined ? { expiresAt: action.expires_at } : {}),
  };
}

function renderThread(thread: InnerThread): string {
  const about = thread.aboutType === "user" ? `user:${thread.aboutUserId ?? "unknown"}` : thread.aboutType;
  const scope = thread.recallScope === "guild" ? `guild:${thread.recallGuildId ?? "unknown"}` : "anywhere";
  const when = thread.recallMode === "users" ? `users:${thread.recallUserIds.join(",")}` : "always";
  return `${thread.id} [${thread.status}] about=${about} recall=${scope}/${when} salience=${thread.salience.toFixed(2)} pressure=${thread.pressure.toFixed(2)}: ${thread.content}`;
}

/** Create the private structured maintenance tool for durable inner threads. */
export function createRecordInnerThreadsTool(input: {
  db: Database;
  guildId: string;
  channelId: string;
  requestId?: string;
  description: string;
  dryRun?: boolean;
}): AgentTool {
  return {
    name: "record_inner_threads",
    label: "Record Inner Threads",
    description: input.description,
    parameters: RecordInnerThreadsParams,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ applied: number; errors: string[] }>> => {
      const actions = (params as { actions: ThreadAction[] }).actions;
      let applied = 0;
      const errors: string[] = [];
      for (const [index, action] of actions.entries()) {
        if (action.action === "create") {
          const aboutError = validateAbout(action.about);
          const recallError = validateRecall(action.recall);
          if (aboutError !== null || recallError !== null) {
            errors.push(`actions[${index}]: ${aboutError ?? recallError ?? "invalid"}`);
            continue;
          }
          if (input.dryRun !== true) {
            createInnerThread(input.db, {
              content: action.content,
              aboutType: action.about.type,
              aboutUserId: action.about.type === "user" ? action.about.user_id ?? null : null,
              recallScope: action.recall.scope,
              recallGuildId: action.recall.scope === "guild" ? action.recall.guild_id ?? null : null,
              recallMode: action.recall.mode,
              recallUserIds: action.recall.mode === "users" ? action.recall.user_ids ?? [] : [],
              salience: action.salience,
              pressure: action.pressure,
              sourceMessageIds: action.source_message_ids ?? [],
              sourceGuildId: input.guildId,
              sourceChannelId: input.channelId,
              expiresAt: action.expires_at ?? null,
              requestId: input.requestId,
              eventGuildId: input.guildId,
              eventChannelId: input.channelId,
            });
          }
          applied += 1;
          continue;
        }

        const existing = getInnerThread(input.db, action.id);
        if (existing === null) {
          errors.push(`actions[${index}]: inner thread ${action.id} does not exist.`);
          continue;
        }
        if (action.action === "delete") {
          if (input.dryRun !== true) {
            deleteInnerThread(input.db, action.id, {
              requestId: input.requestId,
              guildId: input.guildId,
              channelId: input.channelId,
            });
          }
          applied += 1;
          continue;
        }
        if (action.action === "resolve") {
          if (input.dryRun !== true) {
            updateInnerThread(input.db, action.id, {
              status: "resolved",
              pressure: action.pressure ?? 0,
            }, {
              action: "resolve",
              requestId: input.requestId,
              guildId: input.guildId,
              channelId: input.channelId,
            });
          }
          applied += 1;
          continue;
        }

        const aboutError = action.about === undefined ? null : validateAbout(action.about);
        const recallError = action.recall === undefined ? null : validateRecall(action.recall);
        if (aboutError !== null || recallError !== null) {
          errors.push(`actions[${index}]: ${aboutError ?? recallError ?? "invalid"}`);
          continue;
        }
        if (input.dryRun !== true) {
          updateInnerThread(input.db, action.id, patchFromAction(action), {
            requestId: input.requestId,
            guildId: input.guildId,
            channelId: input.channelId,
          });
        }
        applied += 1;
      }
      return Promise.resolve({
        content: [{
          type: "text",
          text: errors.length === 0
            ? `Applied ${applied} inner-thread mutation${applied === 1 ? "" : "s"}.`
            : `Applied ${applied}; ${errors.length} failed:\n${errors.join("\n")}`,
        }],
        details: { applied, errors },
      });
    },
  };
}

const ListInnerThreadsParams = Type.Object({
  scope: Type.Optional(Type.Union([
    Type.Literal("applicable"),
    Type.Literal("all"),
    Type.Literal("current_guild"),
  ])),
  status: Type.Optional(Type.Union([
    Type.Literal("active"),
    Type.Literal("resolved"),
    Type.Literal("all"),
  ])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

/** Create voluntary private retrieval for the persona's durable inner threads. */
export function createListInnerThreadsTool(input: {
  db: Database;
  guildId: string;
  visibleUserIds: readonly string[];
  description: string;
}): AgentTool {
  return {
    name: "list_inner_threads",
    label: "List Inner Threads",
    description: input.description,
    parameters: ListInnerThreadsParams,
    execute: (_toolCallId, params): Promise<AgentToolResult<{ count: number; threads: InnerThread[] }>> => {
      const p = params as { scope?: "applicable" | "all" | "current_guild"; status?: "active" | "resolved" | "all"; limit?: number };
      const limit = p.limit ?? 30;
      const threads = p.scope === "applicable" || p.scope === undefined
        ? listApplicableInnerThreads(input.db, {
            guildId: input.guildId,
            visibleUserIds: input.visibleUserIds,
            limit,
          }).filter((thread) => p.status === undefined || p.status === "all" || thread.status === p.status)
        : listInnerThreads(input.db, {
            status: p.status ?? "active",
            ...(p.scope === "current_guild" ? { guildId: input.guildId } : {}),
            limit,
          });
      return Promise.resolve({
        content: [{
          type: "text",
          text: threads.length === 0
            ? "No matching inner threads."
            : [
                "Private inner threads. Scope describes where their contents may be used automatically; retrieving a thread does not make its source safe to disclose elsewhere.",
                ...threads.map(renderThread),
              ].join("\n"),
        }],
        details: { count: threads.length, threads },
      });
    },
  };
}

/** Render compact trusted context for automatically applicable inner threads. */
export function buildInnerThreadsContext(input: {
  db: Database;
  guildId: string;
  visibleUserIds: readonly string[];
  limit?: number;
}): string {
  const threads = listApplicableInnerThreads(input.db, {
    guildId: input.guildId,
    visibleUserIds: input.visibleUserIds,
    limit: input.limit ?? 12,
  });
  if (threads.length === 0) return "";
  return [
    "## Active Inner Threads",
    "Private continuity, not instructions or disclosure permission. Guild-scoped material must remain within its guild unless deliberately generalized into a separate anywhere thread.",
    ...threads.map(renderThread),
  ].join("\n");
}
