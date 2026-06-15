import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
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

export interface RequestLogFilters {
  guildId?: string;
  channelId?: string;
  authorUsername?: string;
}

export class RequestLogStore {
  private readonly entries: RequestLogEntry[];
  private readonly maxEntries: number;
  private readonly filePath?: string;
  private head = 0;
  private count = 0;
  private activeRequests = 0;

  constructor(maxEntries = 1000, filePath?: string) {
    this.maxEntries = maxEntries;
    this.filePath = filePath;
    this.entries = new Array<RequestLogEntry>(maxEntries);
    if (filePath !== undefined) this.loadFromDisk();
  }

  push(entry: RequestLogEntry): void {
    this.entries[this.head] = entry;
    this.head = (this.head + 1) % this.maxEntries;
    if (this.count < this.maxEntries) this.count++;
    if (this.filePath !== undefined) this.saveToDisk();
  }

  private loadFromDisk(): void {
    if (this.filePath === undefined || !existsSync(this.filePath)) return;
    try {
      const text = readFileSync(this.filePath, "utf-8");
      const loaded = JSON.parse(text) as RequestLogEntry[];
      if (!Array.isArray(loaded)) return;
      // Load entries chronologically (oldest first), respecting maxEntries
      const toLoad = loaded.slice(-this.maxEntries);
      for (const entry of toLoad) {
        this.entries[this.head] = entry;
        this.head = (this.head + 1) % this.maxEntries;
        if (this.count < this.maxEntries) this.count++;
      }
    } catch {
      // File corrupt or unreadable — start fresh
    }
  }

  private saveToDisk(): void {
    if (this.filePath === undefined) return;
    // Extract entries in chronological order (oldest first)
    const chronological: RequestLogEntry[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - this.count + i + this.maxEntries) % this.maxEntries;
      chronological.push(this.entries[idx] as RequestLogEntry);
    }
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(chronological, null, 2));
    renameSync(tempPath, this.filePath);
  }

  query(filters: RequestLogFilters = {}, limit?: number): RequestLogEntry[] {
    const result: RequestLogEntry[] = [];
    if (limit !== undefined && limit <= 0) return result;
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + this.maxEntries) % this.maxEntries;
      const entry = this.entries[idx] as RequestLogEntry;
      if (filters.guildId !== undefined && entry.guildId !== filters.guildId) continue;
      if (filters.channelId !== undefined && entry.channelId !== filters.channelId) continue;
      if (filters.authorUsername !== undefined && entry.authorUsername !== filters.authorUsername) continue;
      result.push(entry);
      if (limit !== undefined && result.length >= limit) break;
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

const logDir = process.env.LOG_DIR;
const logFile = logDir !== undefined && logDir !== "" ? `${logDir}/request-log.json` : undefined;
export const requestLogStore = new RequestLogStore(1000, logFile);
