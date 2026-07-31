import { ChannelType, type Client, type Guild, type GuildBasedChannel, type ThreadChannel } from "discord.js";
import type { AmbientRuntime } from "../ambient/runtime";
import type { loadGlobalConfig } from "../config/loader";
import { resolveGuildConfig } from "../config/loader";
import type { PromptBundle } from "../config/instruction-bundle";
import { inspectPromptScenario, type PromptScenarioId } from "../config/prompt-inspector";
import { listInnerThreads } from "../db/inner-thread-repository";
import { listStagedAssets } from "../db/staged-asset-repository";
import type { createPersonaModeRuntime } from "../modes/runtime";
import type { createPrivateLifeRuntime } from "../private-life/runtime";
import { PRIVATE_LIFE_ACTION_SCOPES, PRIVATE_LIFE_ATTENTION_ORIGINS, PRIVATE_LIFE_CURIOSITY_MODES, PRIVATE_LIFE_TERRITORIES } from "../private-life/types";
import { createRelationshipsManagementApi } from "./relationships-management";
import type { VoiceRuntime } from "../voice/runtime";
import type { createPromptLabRunner } from "./prompt-lab-runtime";
import type { Database } from "../db/database";
import { deleteInnerThread } from "../db/inner-thread-repository";
import { createMemory, deleteMemory, updateMemory } from "../db/memory-repository";
import {
  createNotebook as createStoredNotebook,
  DEFAULT_NOTEBOOK_SHELF_AFTER_MS,
  listNotebookCandidates,
  restoreTrashedNotebook,
  rewriteNotebook,
  setNotebookState,
  trashNotebook,
  type Notebook,
  type NotebookMutationResult,
  type NotebookState,
} from "../db/notebook-repository";
import { channelTypeLabel, isSendableGuildChannel } from "../discord/message-sender";
import {
  deleteStoredManagementMessages,
  getManagementMemory,
  listManagementMemories,
  listManagementMessages,
  storedManagementDirectoryIds,
  updateStoredManagementMessageContent,
  type ManagementChannelLabel,
  type ManagementDirectory,
  type ManagementLabel,
  type ManagementMemoryCreateInput,
  type ManagementMemoryEditInput,
  type ManagementMemoryFilter,
  type ManagementMessageRow,
  type ManagementMemoryRow,
} from "./management";

export type DecoratedManagementMessage = ManagementMessageRow & {
  guildName: string;
  channelName: string;
  channelType: string;
  authorDisplayName: string;
};

export type DecoratedManagementMemory = ManagementMemoryRow & {
  guildName?: string;
  aboutUsername?: string;
  recallWhenUsernames: "always" | string[];
  sourceGuildName?: string;
  sourceChannelName?: string;
};

export type DiscordManagementDeleteResult = {
  attempted: boolean;
  deletedMessageIds: string[];
  failures: Array<{ messageId: string; error: string }>;
};

export type DashboardManagementRuntime = {
  getDirectory: () => Promise<ManagementDirectory>;
  listMessages: (filter: { guildId?: string; channelId?: string; limit?: number }) => { messages: DecoratedManagementMessage[] };
  editMessage: (input: { messageId: string; guildId: string; channelId: string; content: string }) => Promise<{ message: DecoratedManagementMessage }>;
  deleteMessages: (input: { messageIds: string[]; guildId: string; channelId: string; deleteDiscord?: boolean }) => Promise<{
    deletedMessageIds: string[];
    discordDeletion: DiscordManagementDeleteResult;
  }>;
  deleteLatestMessages: (input: { guildId: string; channelId: string; count: number; deleteDiscord?: boolean }) => Promise<{
    deletedMessageIds: string[];
    discordDeletion: DiscordManagementDeleteResult;
    scopedTo: { guildId: string; channelId: string };
  }>;
  deleteInnerThread: (threadId: string) => { deleted: boolean; threadId: string };
  listMemories: (filter: ManagementMemoryFilter) => { memories: DecoratedManagementMemory[] };
  createMemory: (input: ManagementMemoryCreateInput) => { memory: DecoratedManagementMemory };
  editMemory: (input: ManagementMemoryEditInput) => { memory: DecoratedManagementMemory };
  deleteMemory: (memoryId: number) => { deleted: boolean; memoryId: number };
  restoreMemory: (memoryId: number) => { memory: DecoratedManagementMemory };
  listNotebooks: () => { notebooks: Notebook[]; defaultShelfAfterMs: number };
  createNotebook: (input: { title: string; content: string; shelfAfterMs?: number }) => { notebook: Notebook };
  editNotebook: (input: {
    notebookId: number;
    expectedRevision: number;
    title: string;
    content: string;
    shelfAfterMs: number;
  }) => { notebook: Notebook };
  setNotebookState: (input: {
    notebookId: number;
    expectedRevision: number;
    targetState: Exclude<NotebookState, "trashed">;
  }) => { notebook: Notebook };
  deleteNotebook: (input: { notebookId: number; expectedRevision: number }) => { notebook: Notebook };
  userName: (userId: string) => string;
};

export function dashboardTriggerLocation(guild: Guild, channel: unknown): { guildName: string; channelName?: string } {
  const channelName = channel !== null
    && typeof channel === "object"
    && "name" in channel
    && typeof channel.name === "string"
    && channel.name !== ""
    ? channel.name
    : undefined;
  return {
    guildName: guild.name,
    ...(channelName !== undefined ? { channelName } : {}),
  };
}

function sortLabels<T extends ManagementLabel>(labels: T[]): T[] {
  return labels.sort((a, b) => {
    const nameOrder = a.name.localeCompare(b.name);
    return nameOrder !== 0 ? nameOrder : a.id.localeCompare(b.id);
  });
}

function isDiscordMessageDeleteChannel(channel: unknown): channel is {
  messages: { delete: (messageId: string) => Promise<unknown> };
} {
  if (channel === null || typeof channel !== "object" || !("messages" in channel)) return false;
  const messages = (channel as { messages?: unknown }).messages;
  return messages !== undefined
    && messages !== null
    && typeof messages === "object"
    && "delete" in messages
    && typeof (messages as { delete?: unknown }).delete === "function";
}

function assertManagementMemoryState(input: ManagementMemoryCreateInput): void {
  if (input.content.trim() === "") throw new Error("Memory content cannot be empty.");
  if (input.recallIn !== "anywhere" && input.recallIn.guildId.trim() === "") {
    throw new Error("Guild recall requires a guild.");
  }
  if (input.about === "community" && input.recallIn === "anywhere") {
    throw new Error("Community memories must be recalled in one guild.");
  }
  if (input.about === "user" && (input.aboutUserId === undefined || input.aboutUserId === null || input.aboutUserId.trim() === "")) {
    throw new Error("User memories require an about-user.");
  }
  if (input.kind === "journal" && input.about !== "self") throw new Error("Journal memories must be about self.");
  if (input.kind === "scratchpad" && (input.expiresAt === undefined || input.expiresAt === null)) {
    throw new Error("Scratchpad memories require an expiry time.");
  }
  if (input.recallWhen !== "always" && input.recallWhen.length === 0) {
    throw new Error("User-triggered recall requires at least one user.");
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error("Confidence must be between 0 and 1.");
  }
  if (!Number.isFinite(input.priority) || input.priority < 0) throw new Error("Priority must be zero or greater.");
  if (input.importantUntil !== undefined && input.importantUntil !== null) {
    if (!Number.isFinite(input.importantUntil) || input.importantUntil <= Date.now()) {
      throw new Error("Important-until time must be in the future.");
    }
    if (input.priority <= 0) throw new Error("Important-until time requires important priority.");
  }
}

export function createDashboardManagementRuntime(input: {
  client: Client;
  db: Database;
  defaultNotebookShelfAfterMs?: number;
}): DashboardManagementRuntime {
  const storedUsernameStatement = input.db.raw.prepare(
    `SELECT author_username
     FROM messages
     WHERE user_id = ? AND is_synthetic = 0 AND is_prompt_only = 0 AND trim(author_username) <> ''
     ORDER BY created_at DESC, id DESC
     LIMIT 1`
  );
  const storedUsernameCache = new Map<string, string>();
  const attemptedDirectoryUserFetches = new Set<string>();
  const managementGuildName = (guildId: string): string => input.client.guilds.cache.get(guildId)?.name ?? guildId;

  const managementChannelName = (channelId: string): { name: string; type: string } => {
    const channel = input.client.channels.cache.get(channelId);
    if (channel !== undefined && "name" in channel && typeof channel.name === "string" && channel.name !== "") {
      return {
        name: channel.name,
        type: "type" in channel && typeof channel.type === "number" ? channelTypeLabel(channel as GuildBasedChannel | ThreadChannel) : "channel",
      };
    }
    return { name: channelId, type: "stored" };
  };

  const managementUserName = (userId: string): string => {
    const liveName = input.client.users.cache.get(userId)?.username
      ?? input.client.guilds.cache.find((guild) => guild.members.cache.has(userId))?.members.cache.get(userId)?.user.username;
    if (liveName !== undefined) return liveName;
    const cached = storedUsernameCache.get(userId);
    if (cached !== undefined) return cached;
    const row = storedUsernameStatement.get(userId) as { author_username: string } | null;
    if (row !== null) {
      storedUsernameCache.set(userId, row.author_username);
      return row.author_username;
    }
    return userId;
  };

  const buildManagementDirectory = async (): Promise<ManagementDirectory> => {
    const stored = storedManagementDirectoryIds(input.db);
    const guilds = new Map<string, ManagementLabel>();
    for (const guild of input.client.guilds.cache.values()) {
      guilds.set(guild.id, { id: guild.id, name: guild.name });
    }
    for (const guildId of stored.guildIds) {
      if (!guilds.has(guildId)) guilds.set(guildId, { id: guildId, name: managementGuildName(guildId) });
    }

    const channels = new Map<string, ManagementChannelLabel>();
    for (const channel of input.client.channels.cache.values()) {
      if (!isSendableGuildChannel(channel)) continue;
      const label = managementChannelName(channel.id);
      channels.set(`${channel.guildId}:${channel.id}`, {
        id: channel.id,
        guildId: channel.guildId,
        name: label.name,
        type: label.type,
      });
    }
    for (const pair of stored.channelPairs) {
      const key = `${pair.guildId}:${pair.id}`;
      if (channels.has(key)) continue;
      const label = managementChannelName(pair.id);
      channels.set(key, {
        id: pair.id,
        guildId: pair.guildId,
        name: label.name,
        type: label.type,
      });
    }

    const users = new Map<string, ManagementLabel>();
    for (const user of input.client.users.cache.values()) {
      users.set(user.id, { id: user.id, name: user.username });
    }
    for (const storedUser of stored.userLabels) {
      const existing = users.get(storedUser.id);
      if (existing === undefined || existing.name === existing.id) {
        const liveName = managementUserName(storedUser.id);
        users.set(storedUser.id, {
          id: storedUser.id,
          name: liveName === storedUser.id ? storedUser.name : liveName,
        });
      }
    }
    for (const userId of stored.userIds) {
      if (!users.has(userId)) users.set(userId, { id: userId, name: managementUserName(userId) });
    }
    const unresolvedUsers = [...users.values()].filter((user) => user.name === user.id && !attemptedDirectoryUserFetches.has(user.id));
    await Promise.all(unresolvedUsers.map(async (user) => {
      attemptedDirectoryUserFetches.add(user.id);
      const fetched = await input.client.users.fetch(user.id).catch(() => null);
      if (fetched !== null) {
        storedUsernameCache.set(user.id, fetched.username);
        users.set(user.id, { id: user.id, name: fetched.username });
      }
    }));

    return {
      guilds: sortLabels([...guilds.values()]),
      channels: sortLabels([...channels.values()]),
      users: sortLabels([...users.values()]),
    };
  };

  const decorateManagementMessage = (row: ManagementMessageRow): DecoratedManagementMessage => {
    const channel = managementChannelName(row.channelId);
    return {
      ...row,
      guildName: managementGuildName(row.guildId),
      channelName: channel.name,
      channelType: channel.type,
      authorDisplayName: managementUserName(row.userId),
    };
  };

  const decorateManagementMemory = (row: ManagementMemoryRow): DecoratedManagementMemory => {
    const sourceChannel = row.sourceChannelId !== null ? managementChannelName(row.sourceChannelId) : null;
    return {
      ...row,
      ...(row.recallIn !== "anywhere" ? { guildName: managementGuildName(row.recallIn.guildId) } : {}),
      ...(row.aboutUserId !== null ? { aboutUsername: managementUserName(row.aboutUserId) } : {}),
      recallWhenUsernames: row.recallWhen === "always" ? "always" : row.recallWhen.map(managementUserName),
      ...(row.sourceGuildId !== null ? { sourceGuildName: managementGuildName(row.sourceGuildId) } : {}),
      ...(sourceChannel !== null ? { sourceChannelName: sourceChannel.name } : {}),
    };
  };

  const tryDeleteDiscordManagementMessages = async (deleteInput: {
    channelId: string;
    messageIds: readonly string[];
    enabled: boolean;
  }): Promise<DiscordManagementDeleteResult> => {
    if (!deleteInput.enabled) return { attempted: false, deletedMessageIds: [], failures: [] };
    const channel = await input.client.channels.fetch(deleteInput.channelId).catch(() => null);
    if (!isDiscordMessageDeleteChannel(channel)) {
      return {
        attempted: true,
        deletedMessageIds: [],
        failures: deleteInput.messageIds.map((messageId) => ({
          messageId,
          error: "Channel is unavailable or does not expose message deletion.",
        })),
      };
    }

    const deletedMessageIds: string[] = [];
    const failures: Array<{ messageId: string; error: string }> = [];
    for (const messageId of deleteInput.messageIds) {
      try {
        await channel.messages.delete(messageId);
        deletedMessageIds.push(messageId);
      } catch (err) {
        failures.push({
          messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { attempted: true, deletedMessageIds, failures };
  };

  const deleteManagementMessageState = async (deleteInput: {
    messageIds: string[];
    guildId: string;
    channelId: string;
    deleteDiscord?: boolean;
  }): Promise<{ deletedMessageIds: string[]; discordDeletion: DiscordManagementDeleteResult }> => {
    const requestedIds = new Set(deleteInput.messageIds);
    const validRows = listManagementMessages(input.db, {
      guildId: deleteInput.guildId,
      channelId: deleteInput.channelId,
      limit: 200,
    }).filter((row) => requestedIds.has(row.id));
    const validMessageIds = validRows.map((row) => row.id);
    const discordDeletion = await tryDeleteDiscordManagementMessages({
      channelId: deleteInput.channelId,
      messageIds: validMessageIds,
      enabled: deleteInput.deleteDiscord === true,
    });
    const deleted = deleteStoredManagementMessages(input.db, {
      ids: validMessageIds,
      guildId: deleteInput.guildId,
      channelId: deleteInput.channelId,
    });
    return {
      deletedMessageIds: deleted.messageIds,
      discordDeletion,
    };
  };

  const editManagementMessageState = (editInput: {
    messageId: string;
    guildId: string;
    channelId: string;
    content: string;
  }): Promise<{ message: DecoratedManagementMessage }> => {
    const row = updateStoredManagementMessageContent(input.db, {
      id: editInput.messageId,
      guildId: editInput.guildId,
      channelId: editInput.channelId,
      content: editInput.content,
    });
    if (row === null) {
      throw new Error("Stored message was not found for that exact guild/channel, or content was empty.");
    }
    return Promise.resolve({ message: decorateManagementMessage(row) });
  };

  const deleteLatestManagementMessages = async (latestInput: {
    guildId: string;
    channelId: string;
    count: number;
    deleteDiscord?: boolean;
  }): Promise<{
    deletedMessageIds: string[];
    discordDeletion: DiscordManagementDeleteResult;
    scopedTo: { guildId: string; channelId: string };
  }> => {
    const count = Math.max(1, Math.min(20, Math.trunc(latestInput.count)));
    const rows = listManagementMessages(input.db, {
      guildId: latestInput.guildId,
      channelId: latestInput.channelId,
      limit: count,
    });
    const deleted = await deleteManagementMessageState({
      messageIds: rows.map((row) => row.id),
      guildId: latestInput.guildId,
      channelId: latestInput.channelId,
      deleteDiscord: latestInput.deleteDiscord,
    });
    return {
      ...deleted,
      scopedTo: { guildId: latestInput.guildId, channelId: latestInput.channelId },
    };
  };

  const createManagementMemoryState = (memoryInput: ManagementMemoryCreateInput): { memory: DecoratedManagementMemory } => {
    assertManagementMemoryState(memoryInput);
    const memoryId = createMemory(input.db, {
      guildId: memoryInput.recallIn === "anywhere" ? "" : memoryInput.recallIn.guildId,
      about: memoryInput.about,
      aboutUserId: memoryInput.aboutUserId,
      recallIn: memoryInput.recallIn,
      recallWhen: memoryInput.recallWhen,
      kind: memoryInput.kind,
      content: memoryInput.content,
      sourceMessageId: memoryInput.sourceMessageId,
      provenance: memoryInput.provenance,
      confidence: memoryInput.confidence,
      priority: memoryInput.priority,
      importantUntil: memoryInput.importantUntil,
      expiresAt: memoryInput.expiresAt,
    });
    const row = getManagementMemory(input.db, memoryId);
    if (row === null) throw new Error("Memory disappeared after creation.");
    return { memory: decorateManagementMemory(row) };
  };

  const editManagementMemoryState = (memoryInput: ManagementMemoryEditInput): { memory: DecoratedManagementMemory } => {
    const existing = getManagementMemory(input.db, memoryInput.memoryId);
    if (existing === null) throw new Error("Memory not found.");
    if (existing.deletedAt !== null) throw new Error("Deleted memories cannot be edited.");
    const next: ManagementMemoryCreateInput = {
      about: memoryInput.about ?? existing.about,
      aboutUserId: "aboutUserId" in memoryInput ? memoryInput.aboutUserId : existing.aboutUserId,
      recallIn: memoryInput.recallIn ?? existing.recallIn,
      recallWhen: memoryInput.recallWhen ?? existing.recallWhen,
      kind: memoryInput.kind ?? existing.kind,
      content: memoryInput.content ?? existing.content,
      sourceMessageId: "sourceMessageId" in memoryInput ? memoryInput.sourceMessageId : existing.sourceMessageId,
      provenance: "provenance" in memoryInput ? memoryInput.provenance : existing.provenance,
      confidence: memoryInput.confidence ?? existing.confidence,
      priority: memoryInput.priority ?? existing.priority,
      importantUntil: "importantUntil" in memoryInput ? memoryInput.importantUntil : existing.importantUntil,
      expiresAt: "expiresAt" in memoryInput ? memoryInput.expiresAt : existing.expiresAt,
    };
    assertManagementMemoryState(next);
    const updated = updateMemory(input.db, memoryInput.memoryId, {
      about: next.about,
      aboutUserId: next.aboutUserId,
      recallIn: next.recallIn,
      recallWhen: next.recallWhen,
      kind: next.kind,
      content: next.content,
      sourceMessageId: next.sourceMessageId,
      provenance: next.provenance,
      confidence: next.confidence,
      priority: next.priority,
      importantUntil: next.importantUntil,
      expiresAt: next.expiresAt,
    });
    if (!updated) throw new Error("Memory update did not change a row.");
    const row = getManagementMemory(input.db, memoryInput.memoryId);
    if (row === null) throw new Error("Memory disappeared after update.");
    return { memory: decorateManagementMemory(row) };
  };

  const restoreManagementMemoryState = (memoryId: number): { memory: DecoratedManagementMemory } => {
    const existing = getManagementMemory(input.db, memoryId);
    if (existing === null) throw new Error("Memory not found.");
    if (existing.deletedAt === null) throw new Error("Memory is not deleted.");
    if (!updateMemory(input.db, memoryId, { deletedAt: null })) throw new Error("Memory could not be restored.");
    const row = getManagementMemory(input.db, memoryId);
    if (row === null) throw new Error("Memory disappeared after restoration.");
    return { memory: decorateManagementMemory(row) };
  };

  const notebookMutation = (result: NotebookMutationResult): { notebook: Notebook } => {
    if ("notebook" in result) return result;
    if (result.error === "revision_conflict") {
      throw new Error(`Notebook changed at revision ${result.currentRevision}. Reload it before saving.`);
    }
    throw new Error("message" in result ? result.message : "Notebook not found.");
  };
  const defaultNotebookShelfAfterMs = input.defaultNotebookShelfAfterMs ?? DEFAULT_NOTEBOOK_SHELF_AFTER_MS;

  return {
    getDirectory: buildManagementDirectory,
    listMessages: (filter) => ({
      messages: listManagementMessages(input.db, filter).map(decorateManagementMessage),
    }),
    editMessage: editManagementMessageState,
    deleteMessages: deleteManagementMessageState,
    deleteLatestMessages: deleteLatestManagementMessages,
    deleteInnerThread: (threadId) => ({ deleted: deleteInnerThread(input.db, threadId), threadId }),
    listMemories: (filter) => ({
      memories: listManagementMemories(input.db, filter).map(decorateManagementMemory),
    }),
    createMemory: createManagementMemoryState,
    editMemory: editManagementMemoryState,
    deleteMemory: (memoryId) => ({ deleted: deleteMemory(input.db, memoryId), memoryId }),
    restoreMemory: restoreManagementMemoryState,
    listNotebooks: () => ({
      notebooks: [
        ...listNotebookCandidates(input.db),
        ...listNotebookCandidates(input.db, { state: "trashed" }),
      ].sort((a, b) => {
        const editOrder = b.editedAt - a.editedAt;
        return editOrder !== 0 ? editOrder : b.id - a.id;
      }),
      defaultShelfAfterMs: defaultNotebookShelfAfterMs,
    }),
    createNotebook: (notebookInput) => ({
      notebook: createStoredNotebook(input.db, {
        title: notebookInput.title,
        content: notebookInput.content,
        shelfAfterMs: notebookInput.shelfAfterMs ?? defaultNotebookShelfAfterMs,
      }),
    }),
    editNotebook: (notebookInput) => notebookMutation(rewriteNotebook(input.db, notebookInput.notebookId, {
      expectedRevision: notebookInput.expectedRevision,
      title: notebookInput.title,
      content: notebookInput.content,
      shelfAfterMs: notebookInput.shelfAfterMs,
    })),
    setNotebookState: (notebookInput) => {
      const current = listNotebookCandidates(input.db, {
        state: "trashed",
        notebookId: notebookInput.notebookId,
      })[0];
      return notebookMutation(current === undefined
        ? setNotebookState(
            input.db,
            notebookInput.notebookId,
            notebookInput.expectedRevision,
            notebookInput.targetState,
          )
        : restoreTrashedNotebook(
            input.db,
            notebookInput.notebookId,
            notebookInput.expectedRevision,
            notebookInput.targetState,
          ));
    },
    deleteNotebook: (notebookInput) => notebookMutation(trashNotebook(
      input.db,
      notebookInput.notebookId,
      notebookInput.expectedRevision,
    )),
    userName: managementUserName,
  };
}

/** Assemble the dashboard API from its owning runtimes. */
export function createDashboardManagement(input: {
  profile: string;
  client: Client;
  db: Database;
  runtime: DashboardManagementRuntime;
  personaModeRuntime: ReturnType<typeof createPersonaModeRuntime>;
  ambientRuntime: AmbientRuntime;
  privateLifeRuntime: ReturnType<typeof createPrivateLifeRuntime>;
  voiceRuntime: VoiceRuntime;
  runPromptLab: ReturnType<typeof createPromptLabRunner>;
  getGlobalConfig: () => ReturnType<typeof loadGlobalConfig>;
  getPromptBundle: () => PromptBundle;
  getGuildConfig: (guildId: string) => ReturnType<typeof resolveGuildConfig>;
}) {
  const runtime = input.runtime;
  return {
    getPersonaModeStatus: () => {
      const status = input.personaModeRuntime.getStatus();
      return {
        profile: input.profile,
        ...status,
        guilds: status.guilds.map((entry) => ({
          ...entry,
          guildName: input.client.guilds.cache.get(entry.guildId)?.name ?? entry.guildId,
        })),
      };
    },
    getDirectory: runtime.getDirectory,
    listMessages: runtime.listMessages,
    editMessage: runtime.editMessage,
    deleteMessages: runtime.deleteMessages,
    deleteLatestMessages: runtime.deleteLatestMessages,
    inspectPrompts: (inspectInput: {
      scenario: PromptScenarioId;
      provider: "openai-codex" | "openrouter";
      guildId?: string;
    }) => {
      const guildConfig = inspectInput.guildId !== undefined
        ? input.getGuildConfig(inspectInput.guildId)
        : resolveGuildConfig(input.getGlobalConfig(), { guildId: "dashboard", slug: "dashboard" });
      return inspectPromptScenario({
        bundle: input.getPromptBundle(),
        profile: input.profile,
        scenario: inspectInput.scenario,
        provider: inspectInput.provider,
        transport: guildConfig.promptTransport,
      });
    },
    runPromptLab: input.runPromptLab,
    runPromptLabAmbientInitiative: input.ambientRuntime.runPromptLabAmbientInitiative,
    runPromptLabPrivateLife: (runInput: {
      guildId: string;
      channelId: string;
      origin?: string;
      mode?: string;
      territory?: string;
      actionScope?: string;
    }) => {
      const origin = PRIVATE_LIFE_ATTENTION_ORIGINS.find((candidate) => candidate === runInput.origin);
      const mode = PRIVATE_LIFE_CURIOSITY_MODES.find((candidate) => candidate === runInput.mode);
      const territory = PRIVATE_LIFE_TERRITORIES.find((candidate) => candidate === runInput.territory);
      const actionScope = PRIVATE_LIFE_ACTION_SCOPES.find((candidate) => candidate === runInput.actionScope);
      if (runInput.origin !== undefined && origin === undefined) throw new Error(`Unknown private-life origin: ${runInput.origin}`);
      if (runInput.mode !== undefined && mode === undefined) throw new Error(`Unknown private-life mode: ${runInput.mode}`);
      if (runInput.territory !== undefined && territory === undefined) throw new Error(`Unknown private-life territory: ${runInput.territory}`);
      if (runInput.actionScope !== undefined && actionScope === undefined) throw new Error(`Unknown private-life action scope: ${runInput.actionScope}`);
      return input.privateLifeRuntime.runPromptLab({
        guildId: runInput.guildId,
        channelId: runInput.channelId,
        ...(origin !== undefined ? { origin } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(territory !== undefined ? { territory } : {}),
        ...(actionScope !== undefined ? { actionScope } : {}),
      });
    },
    listPrivateLifeEpisodes: (limit?: number) => ({ episodes: input.privateLifeRuntime.listEpisodes(limit) }),
    listInnerThreads: (filter: { guildId?: string; status?: "active" | "resolved"; limit?: number }) => ({
      threads: listInnerThreads(input.db, filter),
    }),
    deleteInnerThread: runtime.deleteInnerThread,
    listStagedAssets: (filter: { guildId?: string; channelId?: string; unresolvedOnly?: boolean; limit?: number }) => ({
      assets: listStagedAssets(input.db, filter),
    }),
    listMemories: runtime.listMemories,
    createMemory: runtime.createMemory,
    editMemory: runtime.editMemory,
    deleteMemory: runtime.deleteMemory,
    restoreMemory: runtime.restoreMemory,
    listNotebooks: runtime.listNotebooks,
    createNotebook: runtime.createNotebook,
    editNotebook: runtime.editNotebook,
    setNotebookState: runtime.setNotebookState,
    deleteNotebook: runtime.deleteNotebook,
    relationships: createRelationshipsManagementApi({
      db: input.db,
      getGlobalConfig: input.getGlobalConfig,
      getGuildConfig: () => resolveGuildConfig(input.getGlobalConfig(), { guildId: "dashboard", slug: "dashboard" }),
    }),
    voice: {
      getSnapshot: () => input.voiceRuntime.snapshot(),
      subscribe: (listener: (snapshot: object) => void) => input.voiceRuntime.subscribe(listener),
      listChannels: () => ({
        channels: [...input.client.guilds.cache.values()].flatMap((guild) => [...guild.channels.cache.values()]
          .filter((channel) => channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice)
          .map((channel) => ({
            id: channel.id,
            name: channel.name,
            guildId: guild.id,
            guildName: guild.name,
            members: [...channel.members.values()]
              .filter((member) => !member.user.bot)
              .map((member) => member.user.username),
          }))),
      }),
      join: async (channelId: string) => await input.voiceRuntime.join(channelId),
      leave: async () => {
        await input.voiceRuntime.leave("Voice session ended from the dashboard.");
        return input.voiceRuntime.snapshot();
      },
      inject: async (text: string) => {
        const snapshot = input.voiceRuntime.snapshot();
        if (snapshot.guildId === undefined) throw new Error("2B is not connected to a voice channel.");
        return await input.voiceRuntime.inject({
          guildId: snapshot.guildId,
          userId: "dashboard",
          username: "dashboard",
          text,
          trusted: true,
        });
      },
    },
  };
}
