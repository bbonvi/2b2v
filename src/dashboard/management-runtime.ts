import type { Client, Guild, GuildBasedChannel, ThreadChannel } from "discord.js";
import type { Database } from "../db/database";
import { createMemory, deleteMemory, updateMemory } from "../db/memory-repository";
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
  subjectUsername?: string;
  appliesToUsernames: "all" | string[];
  sourceGuildName?: string;
  sourceChannelName?: string;
};

export type DiscordManagementDeleteResult = {
  attempted: boolean;
  deletedMessageIds: string[];
  failures: Array<{ messageId: string; error: string }>;
};

export type DashboardManagementRuntime = {
  getDirectory: () => ManagementDirectory;
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
  listMemories: (filter: ManagementMemoryFilter) => { memories: DecoratedManagementMemory[] };
  createMemory: (input: ManagementMemoryCreateInput) => { memory: DecoratedManagementMemory };
  editMemory: (input: ManagementMemoryEditInput) => { memory: DecoratedManagementMemory };
  deleteMemory: (memoryId: number) => { deleted: boolean; memoryId: number };
  restoreMemory: (memoryId: number) => { memory: DecoratedManagementMemory };
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
  if (input.scope === "guild" && (input.guildId === undefined || input.guildId === null || input.guildId.trim() === "")) {
    throw new Error("Guild memories require a guild.");
  }
  if (input.scope === "user" && (input.subjectUserId === undefined || input.subjectUserId === null || input.subjectUserId.trim() === "")) {
    throw new Error("User memories require a subject.");
  }
  if (input.kind === "journal" && input.scope !== "self") throw new Error("Journal memories must use self scope.");
  if (input.kind === "scratchpad" && (input.expiresAt === undefined || input.expiresAt === null)) {
    throw new Error("Scratchpad memories require an expiry time.");
  }
  if (input.appliesTo !== "all" && input.appliesTo.length === 0) {
    throw new Error("Targeted applicability requires at least one user.");
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error("Confidence must be between 0 and 1.");
  }
  if (!Number.isFinite(input.priority) || input.priority < 0) throw new Error("Priority must be zero or greater.");
}

export function createDashboardManagementRuntime(input: {
  client: Client;
  db: Database;
}): DashboardManagementRuntime {
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

  const managementUserName = (userId: string): string =>
    input.client.users.cache.get(userId)?.username
    ?? input.client.guilds.cache.find((guild) => guild.members.cache.has(userId))?.members.cache.get(userId)?.user.username
    ?? userId;

  const buildManagementDirectory = (): ManagementDirectory => {
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
    for (const userId of stored.userIds) {
      if (!users.has(userId)) users.set(userId, { id: userId, name: managementUserName(userId) });
    }

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
      ...(row.guildId !== null ? { guildName: managementGuildName(row.guildId) } : {}),
      ...(row.subjectUserId !== null ? { subjectUsername: managementUserName(row.subjectUserId) } : {}),
      appliesToUsernames: row.appliesTo === "all" ? "all" : row.appliesTo.map(managementUserName),
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
      guildId: memoryInput.guildId ?? "",
      scope: memoryInput.scope,
      subjectUserId: memoryInput.subjectUserId,
      appliesTo: memoryInput.appliesTo,
      kind: memoryInput.kind,
      content: memoryInput.content,
      sourceMessageId: memoryInput.sourceMessageId,
      provenance: memoryInput.provenance,
      confidence: memoryInput.confidence,
      priority: memoryInput.priority,
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
      scope: memoryInput.scope ?? existing.scope,
      guildId: "guildId" in memoryInput ? memoryInput.guildId : existing.guildId,
      subjectUserId: "subjectUserId" in memoryInput ? memoryInput.subjectUserId : existing.subjectUserId,
      appliesTo: memoryInput.appliesTo ?? existing.appliesTo,
      kind: memoryInput.kind ?? existing.kind,
      content: memoryInput.content ?? existing.content,
      sourceMessageId: "sourceMessageId" in memoryInput ? memoryInput.sourceMessageId : existing.sourceMessageId,
      provenance: "provenance" in memoryInput ? memoryInput.provenance : existing.provenance,
      confidence: memoryInput.confidence ?? existing.confidence,
      priority: memoryInput.priority ?? existing.priority,
      expiresAt: "expiresAt" in memoryInput ? memoryInput.expiresAt : existing.expiresAt,
    };
    assertManagementMemoryState(next);
    const updated = updateMemory(input.db, memoryInput.memoryId, {
      scope: next.scope,
      guildId: next.guildId,
      subjectUserId: next.subjectUserId,
      appliesTo: next.appliesTo,
      kind: next.kind,
      content: next.content,
      sourceMessageId: next.sourceMessageId,
      provenance: next.provenance,
      confidence: next.confidence,
      priority: next.priority,
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

  return {
    getDirectory: buildManagementDirectory,
    listMessages: (filter) => ({
      messages: listManagementMessages(input.db, filter).map(decorateManagementMessage),
    }),
    editMessage: editManagementMessageState,
    deleteMessages: deleteManagementMessageState,
    deleteLatestMessages: deleteLatestManagementMessages,
    listMemories: (filter) => ({
      memories: listManagementMemories(input.db, filter).map(decorateManagementMemory),
    }),
    createMemory: createManagementMemoryState,
    editMemory: editManagementMemoryState,
    deleteMemory: (memoryId) => ({ deleted: deleteMemory(input.db, memoryId), memoryId }),
    restoreMemory: restoreManagementMemoryState,
    userName: managementUserName,
  };
}
