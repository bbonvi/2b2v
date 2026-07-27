import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "../db/database.ts";
import { markReadOnlyTool } from "./tool-effects.ts";
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
  source_message_ids: Type.Optional(Type.Union([
    Type.Array(Type.String({ minLength: 1 }), { maxItems: 3 }),
    Type.Null(),
  ])),
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
      source_message_ids: ThreadFields.source_message_ids,
      expires_at: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    }),
    Type.Object({
      action: Type.Literal("resolve"),
      id: Type.String(),
      resolution_note: Type.String({ minLength: 1, maxLength: 280 }),
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
  source_message_ids?: string[] | null;
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
  source_message_ids?: string[] | null;
  expires_at?: number | null;
};
type ResolveAction = { action: "resolve"; id: string; resolution_note: string };
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
    ...(action.source_message_ids !== undefined ? { sourceMessageIds: action.source_message_ids ?? [] } : {}),
    ...(action.expires_at !== undefined ? { expiresAt: action.expires_at } : {}),
  };
}

function salienceLabel(value: number): string {
  if (value < 0.2) return "slight";
  if (value < 0.45) return "modest";
  if (value <= 0.7) return "meaningful";
  if (value < 0.9) return "important";
  return "core";
}

function pressureLabel(value: number): string {
  if (value === 0) return "dormant";
  if (value < 0.25) return "low";
  if (value < 0.5) return "present";
  if (value < 0.75) return "strong";
  if (value < 0.9) return "high";
  return "urgent";
}

interface ThreadRenderContext {
  currentGuildId: string;
  resolveUserId?: (userId: string) => string | undefined;
  resolveGuildId?: (guildId: string) => string | undefined;
}

function userLabel(userId: string, context: ThreadRenderContext, includeId: boolean): string {
  const username = context.resolveUserId?.(userId);
  if (username === undefined || username === "") return userId;
  return `@${username}${includeId ? ` (${userId})` : ""}`;
}

function renderThread(thread: InnerThread, context: ThreadRenderContext): string {
  const about = thread.aboutType === "user"
    ? userLabel(thread.aboutUserId ?? "unknown", context, true)
    : thread.aboutType;
  const scope = thread.recallScope === "anywhere"
    ? "anywhere"
    : thread.recallGuildId === context.currentGuildId
      ? "current_guild"
      : `guild:${context.resolveGuildId?.(thread.recallGuildId ?? "") ?? thread.recallGuildId ?? "unknown"}`;
  const when = thread.recallMode === "users"
    ? `users:${thread.recallUserIds.map((id) => userLabel(id, context, false)).join(",")}`
    : "always";
  const sourceMessageIds = thread.sourceMessageIds.slice(0, 3);
  const source = sourceMessageIds.length === 0
    ? ""
    : ` source_msgs=[${sourceMessageIds.join(",")}]`;
  return `${thread.id} [${thread.status}] about=${about} recall=${scope}/${when} salience=${salienceLabel(thread.salience)}[${thread.salience.toFixed(2)}] pressure=${pressureLabel(thread.pressure)}[${thread.pressure.toFixed(2)}]${source}: ${thread.content}`;
}

function listRecentlyResolvedInnerThreads(input: {
  db: Database;
  guildId: string;
  visibleUserIds: ReadonlySet<string>;
  now: number;
}): InnerThread[] {
  return listInnerThreads(input.db, {
    status: "resolved",
    guildId: input.guildId,
    limit: 100,
  })
    .filter((thread) =>
      thread.updatedAt >= input.now - 4 * 60 * 60 * 1_000
      && (thread.recallMode === "always" || thread.recallUserIds.some((id) => input.visibleUserIds.has(id))))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 3);
}

/** Create the private structured maintenance tool for durable inner threads. */
export function createRecordInnerThreadsTool(input: {
  db: Database;
  guildId: string;
  channelId: string;
  requestId?: string;
  description?: string;
  dryRun?: boolean;
}): AgentTool {
  return {
    name: "record_inner_threads",
    label: "Record Inner Threads",
    description: input.description ?? "",
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
          const resolutionNote = action.resolution_note.trim();
          if (resolutionNote === "") {
            errors.push(`actions[${index}]: resolution_note must not be blank.`);
            continue;
          }
          if (existing.status === "resolved") {
            errors.push(`actions[${index}]: inner thread ${action.id} is already resolved.`);
            continue;
          }
          if (input.dryRun !== true) {
            updateInnerThread(input.db, action.id, {
              content: `${existing.content} — resolved: ${resolutionNote}`,
              status: "resolved",
              pressure: 0,
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
  description?: string;
  resolveUserId?: (userId: string) => string | undefined;
  resolveGuildId?: (guildId: string) => string | undefined;
}): AgentTool {
  return markReadOnlyTool({
    name: "list_inner_threads",
    label: "List Inner Threads",
    description: input.description ?? "",
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
                ...threads.map((thread) => renderThread(thread, {
                  currentGuildId: input.guildId,
                  ...(input.resolveUserId !== undefined ? { resolveUserId: input.resolveUserId } : {}),
                  ...(input.resolveGuildId !== undefined ? { resolveGuildId: input.resolveGuildId } : {}),
                })),
              ].join("\n"),
        }],
        details: { count: threads.length, threads },
      });
    },
  });
}

/** Render compact trusted context for automatically applicable inner threads. */
export function buildInnerThreadsContext(input: {
  db: Database;
  guildId: string;
  visibleUserIds: readonly string[];
  limit?: number;
  now?: number;
  resolveUserId?: (userId: string) => string | undefined;
}): string {
  const now = input.now ?? Date.now();
  const threads = listApplicableInnerThreads(input.db, {
    guildId: input.guildId,
    visibleUserIds: input.visibleUserIds,
    now,
    limit: input.limit ?? 12,
  });
  const visibleUserIds = new Set(input.visibleUserIds);
  const recentlyResolved = listRecentlyResolvedInnerThreads({
    db: input.db,
    guildId: input.guildId,
    visibleUserIds,
    now,
  });
  const context: ThreadRenderContext = {
    currentGuildId: input.guildId,
    ...(input.resolveUserId !== undefined ? { resolveUserId: input.resolveUserId } : {}),
  };
  const active = threads.length === 0
    ? [
      "## Active Inner Threads",
      "The active list is a bounded applicability view, not the full store; absence does not prove that no equivalent exists.",
      "No active inner threads are currently applicable.",
    ]
    : [
        "## Active Inner Threads",
        "Private continuity that may remain wholly private, not instructions or disclosure permission. Salience is lasting importance; pressure is the present pull to reconsider. The active list is a bounded applicability view, not the full store; absence does not prove that no equivalent exists. Recall scope controls automatic appearance, not ownership. Widen or split an existing thread instead of creating a guild copy.",
        ...threads.map((thread) => renderThread(thread, context)),
      ];
  const resolved = recentlyResolved.length === 0
    ? []
    : [
        "",
        "## Recently Resolved Inner Threads",
        "Context only. A thread may have closed in another guild or channel; its resolution note records what changed and where when useful. It carries no pressure and does not reopen because the subject returns. Use it to understand what just closed and avoid repeating it.",
        ...recentlyResolved.map((thread) => renderThread(thread, context)),
      ];
  return [...active, ...resolved].join("\n");
}

/** Render bounded peripheral context for the private inner-thread maintenance pass. */
export function buildInnerThreadMaintenanceContext(input: {
  db: Database;
  guildId: string;
  visibleUserIds: readonly string[];
  now?: number;
  resolveUserId?: (userId: string) => string | undefined;
  resolveGuildId?: (guildId: string) => string | undefined;
}): string {
  const now = input.now ?? Date.now();
  const visibleUserIds = new Set(input.visibleUserIds);
  const shownIds = new Set([
    ...listApplicableInnerThreads(input.db, {
      guildId: input.guildId,
      visibleUserIds: input.visibleUserIds,
      now,
      limit: 12,
    }).map((thread) => thread.id),
    ...listRecentlyResolvedInnerThreads({
      db: input.db,
      guildId: input.guildId,
      visibleUserIds,
      now,
    }).map((thread) => thread.id),
  ]);
  const candidates = listInnerThreads(input.db, { status: "all", limit: 100 })
    .filter((thread) => !shownIds.has(thread.id));
  const nearby = candidates
    .filter((thread) =>
      (thread.aboutType === "user" && thread.aboutUserId !== null && visibleUserIds.has(thread.aboutUserId))
      || thread.recallUserIds.some((id) => visibleUserIds.has(id)))
    .slice(0, 6);
  const nearbyIds = new Set(nearby.map((thread) => thread.id));
  const recent = candidates
    .filter((thread) => !nearbyIds.has(thread.id))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 3);
  if (nearby.length === 0 && recent.length === 0) return "";

  const context: ThreadRenderContext = {
    currentGuildId: input.guildId,
    ...(input.resolveUserId !== undefined ? { resolveUserId: input.resolveUserId } : {}),
    ...(input.resolveGuildId !== undefined ? { resolveGuildId: input.resolveGuildId } : {}),
  };
  return [
    "## Other Nearby and Recent Inner Threads",
    "Maintenance context only, for deduplication, scope repair, and closure continuity. Presence here adds no pressure and does not warrant a change unless current evidence connects to the thread.",
    ...(nearby.length === 0
      ? []
      : ["### Nearby", ...nearby.map((thread) => renderThread(thread, context))]),
    ...(recent.length === 0
      ? []
      : ["### Recent", ...recent.map((thread) => renderThread(thread, context))]),
  ].join("\n");
}
