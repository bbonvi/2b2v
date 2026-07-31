import type { Client, Guild } from "discord.js";
import type { HistoryMessage } from "../agent/history-types";
import { formatHistoryContent } from "../agent/history-formatting";
import type { AmbientInitiativeConfig, GuildConfig } from "../config/types";
import type { RequestLog } from "../logger";
import { formatLocalWallClock } from "../time/agent-time";
import type { Database } from "../db/database";
import {
  botChannelPermissions,
  isSendableGuildChannel,
  type SendableGuildChannel,
} from "../discord/message-sender";

export type AmbientInitiativeSignals = {
  now: number;
  inActiveHours: boolean;
  quietMs: number | null;
  lastHumanAt: number | null;
  lastBotAt: number | null;
  recentHumanCount: number;
  recentBotCount: number;
  pendingAmbientCandidates: number;
  activeImageJobs: number;
  strongestThreadPressure: number;
  applicableThreadCount: number;
  applicableThreads: Array<{
    id: string;
    content: string;
    pressure: number;
    recallScope: "anywhere" | "guild";
    recallGuildId: string | null;
  }>;
  lastInitiativeAt: number | null;
  visibleUserIds: string[];
};

export type AmbientInitiativeDecision = {
  shouldWake: boolean;
  wakeProbability: number;
  confidence: number;
  reason: string;
};

/** Use the newest visible human as the primary memory perspective for autonomous initiative. */
export function ambientInitiativeMemoryFocusUserId(
  signals: Pick<AmbientInitiativeSignals, "visibleUserIds">,
): string | undefined {
  return signals.visibleUserIds[0];
}

export function formatBotContacts(guild: Guild, botContactIds: readonly string[]): string {
  return botContactIds.map((id) => {
    const username = guild.members.cache.get(id)?.user.username
      ?? guild.client.users.cache.get(id)?.username;
    return username === undefined ? id : `@${username} (${id})`;
  }).join(", ");
}

export type AmbientInitiativePressure = {
  rawValue: number;
  value: number;
  roll: number;
  passed: boolean;
  adjustments: string[];
  inputs: Record<string, number | boolean | string | null>;
};

export function randomAmbientInitiativeDelay(min: number, max: number): number {
  return min + Math.random() * Math.max(0, max - min);
}

export function resolveAmbientInitiativeMainChannel(input: {
  guild: Guild;
  config: AmbientInitiativeConfig;
  client: Client;
  db: Database;
}): SendableGuildChannel | null {
  if (input.config.mainChannelId !== undefined && input.config.mainChannelId !== "") {
    const channel = input.client.channels.cache.get(input.config.mainChannelId);
    return channel !== undefined
      && isSendableGuildChannel(channel)
      && channel.guildId === input.guild.id
      && botChannelPermissions(input.client, channel).canSend
      ? channel
      : null;
  }
  const after = Date.now() - input.config.mainChannelLookbackDays * 86_400_000;
  const rows = input.db.raw.prepare(
    `SELECT channel_id, COUNT(*) AS count
     FROM messages
     WHERE guild_id = ? AND is_bot = 0 AND is_synthetic = 0
       AND is_prompt_only = 0 AND created_at >= ?
     GROUP BY channel_id ORDER BY count DESC`,
  ).all(input.guild.id, after) as Array<{ channel_id: string; count: number }>;
  for (const row of rows) {
    if (row.count < input.config.minMainChannelHumanMessages) continue;
    const channel = input.client.channels.cache.get(row.channel_id);
    if (channel !== undefined
      && isSendableGuildChannel(channel)
      && channel.guildId === input.guild.id
      && botChannelPermissions(input.client, channel).canSend) {
      return channel;
    }
  }
  return null;
}

export function clampAmbientInitiativeValue(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Apply ordinary social resistance while allowing genuinely high pressure to overcome it. */
export function applyAmbientInitiativeResistance(value: number, resistance: number): number {
  const boundedValue = clampAmbientInitiativeValue(value);
  const boundedResistance = clampAmbientInitiativeValue(resistance);
  return boundedValue * (boundedResistance + boundedValue * (1 - boundedResistance));
}

/** Calculate the probability that one cheap Ambient Initiative check reaches its evaluator. */
export function calculateAmbientInitiativePressure(
  config: AmbientInitiativeConfig,
  signals: AmbientInitiativeSignals,
  roll = Math.random(),
): AmbientInitiativePressure {
  const threadAdjusted = config.basePressure
    + signals.strongestThreadPressure * (1 - config.basePressure);
  let value = threadAdjusted;
  const adjustments: string[] = [];
  const resist = (condition: boolean, label: string, resistance: number): void => {
    if (!condition) return;
    value = applyAmbientInitiativeResistance(value, resistance);
    adjustments.push(label);
  };
  resist(!signals.inActiveHours, "outside_active_hours", 0.25);
  resist(signals.lastHumanAt === null, "no_recent_human_activity", 0.2);
  resist(signals.quietMs !== null && signals.quietMs < config.quietWindowMs, "room_not_quiet", 0.45);
  resist(
    signals.quietMs !== null && signals.quietMs < config.recentActivityMinMs,
    "human_activity_too_recent",
    0.6,
  );
  resist(
    signals.quietMs !== null && signals.quietMs > config.recentActivityMaxMs,
    "room_activity_stale",
    0.45,
  );
  resist(
    signals.lastBotAt !== null && signals.now - signals.lastBotAt < config.botCooldownMs,
    "recent_actor_output",
    0.35,
  );
  resist(
    signals.lastInitiativeAt !== null && signals.now - signals.lastInitiativeAt < config.cooldownMs,
    "recent_visible_initiative",
    0.2,
  );
  value = clampAmbientInitiativeValue(value);
  return {
    rawValue: threadAdjusted,
    value,
    roll,
    passed: roll <= value,
    adjustments,
    inputs: {
      basePressure: config.basePressure,
      strongestThreadPressure: signals.strongestThreadPressure,
      applicableThreadCount: signals.applicableThreadCount,
      inActiveHours: signals.inActiveHours,
      quietMs: signals.quietMs,
      recentActorOutput: signals.lastBotAt !== null
        && signals.now - signals.lastBotAt < config.botCooldownMs,
      recentInitiative: signals.lastInitiativeAt !== null
        && signals.now - signals.lastInitiativeAt < config.cooldownMs,
    },
  };
}

function parseClockMinutes(value: string): number {
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

function localClockMinutes(timezone: string, now: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(now));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

export function inAmbientInitiativeActiveHours(
  config: AmbientInitiativeConfig,
  guildConfig: GuildConfig,
  now: number,
): boolean {
  const current = localClockMinutes(config.activeHours.timezone ?? guildConfig.timezone, now);
  const start = parseClockMinutes(config.activeHours.start);
  const end = parseClockMinutes(config.activeHours.end);
  if (start === end) return true;
  return start < end
    ? current >= start && current <= end
    : current >= start || current <= end;
}

export function renderAmbientInitiativeHistory(
  history: readonly HistoryMessage[],
  timezone: string,
): string {
  return history.map((message) => {
    const reply = message.replyToId !== null ? ` reply_to=${message.replyToId}` : "";
    return `[${formatLocalWallClock(message.timestamp, timezone)}] ${message.author} (${message.authorId})${reply}: ${formatHistoryContent(message)}`;
  }).join("\n");
}

export function recordAmbientInitiativeRuntimeAction(
  requestLog: RequestLog,
  id: string,
  tool: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  isError = false,
): void {
  requestLog.recordToolStart(id, tool, args);
  requestLog.recordToolEnd(id, isError, {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  });
}
