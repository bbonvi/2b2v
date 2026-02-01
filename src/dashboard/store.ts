import type { RequestToolCall, RequestLLMCall } from "../logger";

export interface RequestLogEntry {
  requestId: string;
  guildId: string;
  channelId: string;
  authorUsername: string;
  trigger: unknown;
  agentRan: boolean;
  tools: RequestToolCall[];
  llmCalls: RequestLLMCall[];
  totalDurationMs: number;
  error?: string;
  timestamp: string;
}

export class RequestLogStore {
  private readonly entries: RequestLogEntry[];
  private readonly maxEntries: number;
  private head = 0;
  private count = 0;
  private activeRequests = 0;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
    this.entries = new Array<RequestLogEntry>(maxEntries);
  }

  push(entry: RequestLogEntry): void {
    this.entries[this.head] = entry;
    this.head = (this.head + 1) % this.maxEntries;
    if (this.count < this.maxEntries) this.count++;
  }

  query(filters: { guildId?: string; channelId?: string; authorUsername?: string } = {}): RequestLogEntry[] {
    const result: RequestLogEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + this.maxEntries) % this.maxEntries;
      const entry = this.entries[idx] as RequestLogEntry;
      if (filters.guildId !== undefined && entry.guildId !== filters.guildId) continue;
      if (filters.channelId !== undefined && entry.channelId !== filters.channelId) continue;
      if (filters.authorUsername !== undefined && entry.authorUsername !== filters.authorUsername) continue;
      result.push(entry);
    }
    return result;
  }

  getFilterOptions(): { guildIds: string[]; channelIds: string[]; usernames: string[] } {
    const guildIds = new Set<string>();
    const channelIds = new Set<string>();
    const usernames = new Set<string>();
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + this.maxEntries) % this.maxEntries;
      const entry = this.entries[idx] as RequestLogEntry;
      guildIds.add(entry.guildId);
      channelIds.add(entry.channelId);
      usernames.add(entry.authorUsername);
    }
    return {
      guildIds: [...guildIds],
      channelIds: [...channelIds],
      usernames: [...usernames],
    };
  }

  incrementActive(): void {
    this.activeRequests++;
  }

  decrementActive(): void {
    if (this.activeRequests > 0) this.activeRequests--;
  }

  getActiveCount(): number {
    return this.activeRequests;
  }
}

export const requestLogStore = new RequestLogStore();
