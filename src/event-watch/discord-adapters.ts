import type { Client, Message, VoiceState } from "discord.js";
import type { Database } from "../db/database.ts";
import { getAssetsByMessageId } from "../db/asset-repository.ts";
import { registerReactionSyncRuntime } from "../discord/reaction-sync-runtime.ts";
import type { Logger } from "../logger.ts";
import type { EventWatchRuntime } from "./runtime.ts";
import {
  DEFAULT_EVENT_STABILITY_MS,
  type NormalizedWatchEvent,
  type PresenceStatus,
} from "./types.ts";

export interface EventWatchDiscordAdapters {
  reconcilePresenceStates(): void;
  stop(): void;
}

export function normalizeDiscordWatchMessage(input: {
  db: Database;
  message: Message;
  content?: string;
  botUserId?: string;
}): Extract<NormalizedWatchEvent, { type: "message" }> {
  return {
    type: "message",
    eventKey: `message:${input.message.id}`,
    at: input.message.createdTimestamp,
    guildId: input.message.guildId ?? "",
    channelId: input.message.channelId,
    userId: input.message.author.id,
    webhookId: input.message.webhookId,
    content: input.content ?? input.message.content,
    assetKinds: [...new Set(getAssetsByMessageId(input.db, input.message.id).map((asset) => asset.kind))],
    authorIsSelf: input.message.author.id === input.botUserId,
    messageId: input.message.id,
  };
}

function presenceStatus(status: string | null | undefined): PresenceStatus {
  return status === "online" || status === "idle" || status === "dnd" ? status : "offline";
}

/** Fan Discord gateway events into the normalized event-watch runtime. */
export function registerEventWatchDiscordAdapters(input: {
  client: Client;
  db: Database;
  runtime: EventWatchRuntime;
  log: Logger;
  isAcceptingEvents: () => boolean;
  trackTask?: (task: Promise<void>) => void;
  presenceReconcileIntervalMs?: number;
}): EventWatchDiscordAdapters {
  const { client, runtime } = input;

  client.on("presenceUpdate", (oldPresence, newPresence) => {
    if (!input.isAcceptingEvents()) return;
    const guild = newPresence.guild;
    if (guild === null) return;
    const at = Date.now();
    const to = presenceStatus(newPresence.status);
    runtime.ingest({
      type: "presence_state",
      eventKey: `presence-state:${guild.id}:${newPresence.userId}:${to}:${at}`,
      at,
      guildId: guild.id,
      userId: newPresence.userId,
      status: to,
    }, DEFAULT_EVENT_STABILITY_MS.presence);
    if (oldPresence === null) return;
    const from = presenceStatus(oldPresence.status);
    if (from === to) return;
    runtime.ingest({
      type: "presence_transition",
      eventKey: `presence-transition:${guild.id}:${newPresence.userId}:${from}:${to}:${at}`,
      at,
      guildId: guild.id,
      userId: newPresence.userId,
      from,
      to,
    }, DEFAULT_EVENT_STABILITY_MS.presence);
  });

  client.on("voiceStateUpdate", (oldState: VoiceState, newState: VoiceState) => {
    if (!input.isAcceptingEvents() || oldState.channelId === newState.channelId) return;
    const action = oldState.channelId === null ? "join" : newState.channelId === null ? "leave" : "move";
    const at = Date.now();
    runtime.ingest({
      type: "voice",
      eventKey: `voice:${newState.guild.id}:${newState.id}:${action}:${oldState.channelId ?? ""}:${newState.channelId ?? ""}:${at}`,
      at,
      guildId: newState.guild.id,
      userId: newState.id,
      action,
      channelId: newState.channelId ?? oldState.channelId,
      fromChannelId: oldState.channelId,
      toChannelId: newState.channelId,
    }, DEFAULT_EVENT_STABILITY_MS.voice);
  });

  client.on("guildMemberAdd", (member) => {
    if (!input.isAcceptingEvents()) return;
    const at = Date.now();
    runtime.ingest({
      type: "member",
      eventKey: `member:join:${member.guild.id}:${member.id}:${at}`,
      at,
      guildId: member.guild.id,
      userId: member.id,
      action: "join",
    });
  });

  client.on("guildMemberRemove", (member) => {
    if (!input.isAcceptingEvents()) return;
    const at = Date.now();
    runtime.ingest({
      type: "member",
      eventKey: `member:leave:${member.guild.id}:${member.id}:${at}`,
      at,
      guildId: member.guild.id,
      userId: member.id,
      action: "leave",
    });
  });

  registerReactionSyncRuntime({
    client,
    db: input.db,
    log: input.log,
    isAcceptingEvents: input.isAcceptingEvents,
    trackTask: input.trackTask,
    onReaction: (event) => {
      const guildId = event.reaction.message.guildId;
      if (guildId === null) return;
      runtime.ingest({
        type: "reaction",
        eventKey: `reaction:${event.action}:${event.reaction.message.id}:${event.emoji}:${event.user.id}:${Date.now()}`,
        at: Date.now(),
        guildId,
        channelId: event.reaction.message.channelId,
        userId: event.user.id,
        action: event.action,
        messageId: event.reaction.message.id,
        emoji: event.emoji,
        count: event.count,
      }, DEFAULT_EVENT_STABILITY_MS.reaction);
    },
  });

  function reconcilePresenceStates(): void {
    const now = Date.now();
    const bucket = Math.floor(now / 86_400_000);
    for (const guild of client.guilds.cache.values()) {
      for (const member of guild.members.cache.values()) {
        runtime.ingest({
          type: "presence_state",
          eventKey: `presence-state-reconcile:${guild.id}:${member.id}:${bucket}`,
          at: now,
          guildId: guild.id,
          userId: member.id,
          status: presenceStatus(member.presence?.status),
        });
      }
    }
  }

  const timer = setInterval(
    reconcilePresenceStates,
    Math.max(1_000, input.presenceReconcileIntervalMs ?? 60_000),
  );
  reconcilePresenceStates();

  return {
    reconcilePresenceStates,
    stop: () => clearInterval(timer),
  };
}
