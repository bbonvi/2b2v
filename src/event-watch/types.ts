import type { AssetKind } from "../db/asset-repository.ts";

export const PRESENCE_STATUSES = ["online", "idle", "dnd", "offline"] as const;
export type PresenceStatus = typeof PRESENCE_STATUSES[number];

export type WatchSource =
  | { scope: "channel"; channelId?: string }
  | { scope: "guild"; guildId?: string }
  | { scope: "all_guilds" };

export type WatchEvent =
  | {
      type: "message";
      userId?: string;
      webhookId?: string;
      pattern?: string;
      assetKind?: AssetKind | "any";
      includeSelf?: boolean;
    }
  | {
      type: "presence_transition";
      userId?: string;
      from?: PresenceStatus[];
      to: PresenceStatus[];
    }
  | {
      type: "presence_state";
      userId?: string;
      statuses: PresenceStatus[];
    }
  | {
      type: "voice";
      userId?: string;
      action: "join" | "leave" | "move";
      channelId?: string;
    }
  | {
      type: "member";
      userId?: string;
      action: "join" | "leave";
    }
  | {
      type: "reaction";
      userId?: string;
      action: "add" | "remove";
      messageId?: string;
      emoji?: string;
      countAtLeast?: number;
    };

export interface EventWatch {
  id: string;
  source: WatchSource;
  runInGuildId: string;
  runInChannelId: string;
  timezone: string;
  event: WatchEvent;
  after?: string;
  occurrences?: { count: number; withinSeconds: number };
  instruction: string;
  handoffNote: string;
  origin: "persona" | { userId: string; username: string };
  once: boolean;
  cooldownSeconds: number;
  fireCount: number;
  maxFireCount: number | null;
  expiresAt: number | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type NormalizedWatchEvent =
  | {
      type: "message";
      eventKey: string;
      at: number;
      guildId: string;
      channelId: string;
      userId: string;
      webhookId: string | null;
      content: string;
      assetKinds: AssetKind[];
      authorIsSelf: boolean;
      messageId: string;
    }
  | {
      type: "presence_transition";
      eventKey: string;
      at: number;
      guildId: string;
      userId: string;
      from: PresenceStatus;
      to: PresenceStatus;
    }
  | {
      type: "presence_state";
      eventKey: string;
      at: number;
      guildId: string;
      userId: string;
      status: PresenceStatus;
    }
  | {
      type: "voice";
      eventKey: string;
      at: number;
      guildId: string;
      userId: string;
      action: "join" | "leave" | "move";
      channelId: string | null;
      fromChannelId: string | null;
      toChannelId: string | null;
    }
  | {
      type: "member";
      eventKey: string;
      at: number;
      guildId: string;
      userId: string;
      action: "join" | "leave";
    }
  | {
      type: "reaction";
      eventKey: string;
      at: number;
      guildId: string;
      channelId: string;
      userId: string;
      action: "add" | "remove";
      messageId: string;
      emoji: string;
      count: number;
    };

export interface EventWatchPressure {
  maxActivePerGuild: number;
  maxActiveProfile: number;
  maxPendingProfile: number;
  maxWatchFiresPerHour: number;
  maxWatchFiresPerDay: number;
  maxGuildFiresPerHour: number;
  maxGuildFiresPerDay: number;
  maxProfileFiresPerHour: number;
  maxProfileFiresPerDay: number;
}

export const DEFAULT_EVENT_WATCH_PRESSURE: EventWatchPressure = {
  maxActivePerGuild: 100,
  maxActiveProfile: 500,
  maxPendingProfile: 250,
  maxWatchFiresPerHour: 60,
  maxWatchFiresPerDay: 300,
  maxGuildFiresPerHour: 240,
  maxGuildFiresPerDay: 1_000,
  maxProfileFiresPerHour: 600,
  maxProfileFiresPerDay: 3_000,
};

export const DEFAULT_EVENT_COOLDOWN_SECONDS: Record<WatchEvent["type"], number> = {
  message: 0,
  reaction: 5,
  presence_transition: 30,
  presence_state: 30,
  voice: 10,
  member: 0,
};

export const DEFAULT_EVENT_STABILITY_MS = {
  reaction: 2_000,
  presence: 10_000,
  voice: 3_000,
} as const;
