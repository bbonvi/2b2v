import type { Peer, WgServer } from "./types.ts";

const CUSTOM_ID_PREFIX = "vpn";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/** VPN UI session state. */
export interface VpnSession {
  id: string;
  userId: string;
  guildId: string;
  servers: WgServer[];
  profiles: Peer[];
  currentServer: WgServer | null;
  currentProfile: Peer | null;
  createdAt: number;
}

export interface SessionStore {
  create(userId: string, guildId: string): VpnSession;
  get(sessionId: string): VpnSession | undefined;
  delete(sessionId: string): void;
  isOwner(sessionId: string, userId: string): boolean;
  cleanExpired(): void;
}

/**
 * Create a VPN session store with configurable timeout.
 */
export function createSessionStore(timeoutMs: number = DEFAULT_TIMEOUT_MS): SessionStore {
  const sessions = new Map<string, VpnSession>();

  return {
    create(userId: string, guildId: string): VpnSession {
      const session: VpnSession = {
        id: crypto.randomUUID().slice(0, 8),
        userId,
        guildId,
        servers: [],
        profiles: [],
        currentServer: null,
        currentProfile: null,
        createdAt: Date.now(),
      };
      sessions.set(session.id, session);
      return session;
    },

    get(sessionId: string): VpnSession | undefined {
      return sessions.get(sessionId);
    },

    delete(sessionId: string): void {
      sessions.delete(sessionId);
    },

    isOwner(sessionId: string, userId: string): boolean {
      const session = sessions.get(sessionId);
      return session !== undefined && session.userId === userId;
    },

    cleanExpired(): void {
      const now = Date.now();
      for (const [id, session] of sessions) {
        if (now - session.createdAt > timeoutMs) {
          sessions.delete(id);
        }
      }
    },
  };
}

/**
 * Encode a customId for VPN component interactions.
 * Format: vpn:<sessionId>:<action>[:<param>]
 */
export function encodeCustomId(sessionId: string, action: string, param?: string): string {
  const parts = [CUSTOM_ID_PREFIX, sessionId, action];
  if (param !== undefined) {
    parts.push(param);
  }
  return parts.join(":");
}

export interface ParsedCustomId {
  sessionId: string;
  action: string;
  param: string | undefined;
}

/**
 * Parse a customId from VPN component interactions.
 * Returns null if the customId is not a valid VPN customId.
 */
export function parseCustomId(customId: string): ParsedCustomId | null {
  const parts = customId.split(":");
  if (parts.length < 3 || parts[0] !== CUSTOM_ID_PREFIX) {
    return null;
  }
  return {
    sessionId: parts[1] as string,
    action: parts[2] as string,
    param: parts.length > 3 ? parts.slice(3).join(":") : undefined,
  };
}
