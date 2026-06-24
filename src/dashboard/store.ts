import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import type { RequestToolCall, RequestLLMCall } from "../logger";

export interface RequestLogEntry {
  requestId: string;
  guildId: string;
  channelId: string;
  authorUsername: string;
  trigger: unknown;
  triggerContext?: RequestTriggerContext;
  agentRan: boolean;
  status?: "active";
  tools: RequestToolCall[];
  llmCalls: RequestLLMCall[];
  totalDurationMs: number;
  error?: string;
  startedAt?: string;
  timestamp: string;
}

export interface RequestLogSummary {
  requestId: string;
  guildId: string;
  channelId: string;
  authorUsername: string;
  trigger: unknown;
  triggerContext?: RequestTriggerContext;
  agentRan: boolean;
  toolCount: number;
  runtimeActionCount: number;
  llmCallCount: number;
  estimatedCostUsd: number | null;
  totalDurationMs: number;
  hasError: boolean;
  status?: "active";
  timestamp: string;
}

export interface RequestLogFilters {
  guildId?: string;
  channelId?: string;
  authorUsername?: string;
}

export interface RequestTriggerContext {
  messageId?: string;
  guildName?: string;
  channelName?: string;
  authorUsername?: string;
  content?: string;
  translatedContent?: string;
  sourceMessageId?: string;
  sourceQuote?: string;
}

const BASE64_PLACEHOLDER_MIN_LENGTH = 1_024;
const BASE64_SAMPLE_LENGTH = 4_096;
const BASE64_FIELD_NAMES = new Set(["base64", "b64json", "data", "image", "imageurl"]);

export class RequestLogStore {
  private readonly entries: RequestLogEntry[];
  private readonly maxEntries: number;
  private readonly filePath?: string;
  private head = 0;
  private count = 0;
  private activeRequests = 0;
  private readonly activeEntries = new Map<string, RequestLogEntry>();

  constructor(maxEntries = 1000, filePath?: string) {
    this.maxEntries = maxEntries;
    this.filePath = filePath;
    this.entries = new Array<RequestLogEntry>(maxEntries);
    if (filePath !== undefined) this.loadFromDisk();
  }

  push(entry: RequestLogEntry): void {
    this.activeEntries.delete(entry.requestId);
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
    for (const entry of [...this.activeEntries.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp))) {
      if (!entryMatchesFilters(entry, filters)) continue;
      result.push(withLiveActiveDurations(entry));
      if (limit !== undefined && result.length >= limit) return result;
    }
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + this.maxEntries) % this.maxEntries;
      const entry = this.entries[idx] as RequestLogEntry;
      if (!entryMatchesFilters(entry, filters)) continue;
      result.push(entry);
      if (limit !== undefined && result.length >= limit) break;
    }
    return result;
  }

  /** Returns compact rows for the dashboard list without large tool or LLM payloads. */
  querySummaries(filters: RequestLogFilters = {}, limit?: number): RequestLogSummary[] {
    return this.query(filters, limit).map((entry) => toSummary(entry));
  }

  /** Finds one full dashboard log entry by request ID for on-demand expansion. */
  getByRequestId(requestId: string): RequestLogEntry | null {
    const active = this.activeEntries.get(requestId);
    if (active !== undefined) return withLiveActiveDurations(active);
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + this.maxEntries) % this.maxEntries;
      const entry = this.entries[idx] as RequestLogEntry;
      if (entry.requestId === requestId) return entry;
    }
    return null;
  }

  /** Finds one entry for dashboard detail responses with oversized base64 image data replaced. */
  getSanitizedByRequestId(requestId: string): RequestLogEntry | null {
    const entry = this.getByRequestId(requestId);
    return entry === null ? null : sanitizeDashboardLogEntry(entry);
  }

  getFilterOptions(): { guildIds: string[]; channelIds: string[]; usernames: string[] } {
    const guildIds = new Set<string>();
    const channelIds = new Set<string>();
    const usernames = new Set<string>();
    for (const entry of this.activeEntries.values()) {
      guildIds.add(entry.guildId);
      channelIds.add(entry.channelId);
      usernames.add(entry.authorUsername);
    }
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
    return Math.max(this.activeRequests, this.activeEntries.size);
  }

  upsertActive(entry: RequestLogEntry): void {
    this.activeEntries.set(entry.requestId, entry);
  }

  removeActive(requestId: string): void {
    this.activeEntries.delete(requestId);
  }
}

function entryMatchesFilters(entry: RequestLogEntry, filters: RequestLogFilters): boolean {
  if (filters.guildId !== undefined && entry.guildId !== filters.guildId) return false;
  if (filters.channelId !== undefined && entry.channelId !== filters.channelId) return false;
  if (filters.authorUsername !== undefined && entry.authorUsername !== filters.authorUsername) return false;
  return true;
}

function elapsedSince(iso: string | undefined, now: number): number | undefined {
  if (iso === undefined) return undefined;
  const startedAt = Date.parse(iso);
  return Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : undefined;
}

function withLiveActiveDurations(entry: RequestLogEntry): RequestLogEntry {
  if (entry.status !== "active") return entry;
  const now = Date.now();
  return {
    ...entry,
    totalDurationMs: elapsedSince(entry.startedAt ?? entry.timestamp, now) ?? entry.totalDurationMs,
    tools: entry.tools.map((tool) => ({
      ...tool,
      durationMs: tool.status === "running"
        ? elapsedSince(tool.startedAt, now) ?? tool.durationMs
        : tool.durationMs,
    })),
    llmCalls: entry.llmCalls.map((call) => ({
      ...call,
      durationMs: call.status === "running"
        ? elapsedSince(call.startedAt, now) ?? call.durationMs
        : call.durationMs,
    })),
  };
}

function sanitizeDashboardLogEntry(entry: RequestLogEntry): RequestLogEntry {
  return {
    ...entry,
    trigger: sanitizeDashboardValue(entry.trigger),
    triggerContext: entry.triggerContext !== undefined
      ? sanitizeDashboardValue(entry.triggerContext) as RequestTriggerContext
      : undefined,
    tools: entry.tools.map((tool) => ({
      ...tool,
      args: sanitizeDashboardRecord(tool.args),
      result: tool.result !== undefined ? sanitizeDashboardString(tool.result, "result") : undefined,
    })),
    llmCalls: entry.llmCalls.map((call) => ({
      ...call,
      contentTypes: [...call.contentTypes],
      emittedToolCalls: call.emittedToolCalls?.map((toolCall) => ({
        ...toolCall,
        args: sanitizeDashboardRecord(toolCall.args),
      })),
      outputText: call.outputText !== undefined ? sanitizeDashboardString(call.outputText, "outputText") : undefined,
      requestPayload: sanitizeDashboardValue(call.requestPayload, "requestPayload"),
      responsePayload: sanitizeDashboardValue(call.responsePayload, "responsePayload"),
    })),
  };
}

function sanitizeDashboardRecord(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = sanitizeDashboardValue(item, key);
  }
  return result;
}

function sanitizeDashboardValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") return sanitizeDashboardString(value, key);
  if (Array.isArray(value)) return value.map((item) => sanitizeDashboardValue(item, key));
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [childKey, item] of Object.entries(value)) {
      result[childKey] = sanitizeDashboardValue(item, childKey);
    }
    return result;
  }
  return value;
}

function sanitizeDashboardString(value: string, key: string): string {
  const dataUri = dataUriBase64PayloadOffset(value);
  if (dataUri !== null) {
    return `${value.slice(0, dataUri)}[${formatApproxKb(value.length - dataUri)} base64 truncated]`;
  }

  if (isLikelyBase64ImageField(key, value)) {
    return `[${formatApproxKb(value.length)} base64 truncated]`;
  }

  return value;
}

function dataUriBase64PayloadOffset(value: string): number | null {
  if (!value.startsWith("data:")) return null;
  const comma = value.indexOf(",");
  if (comma === -1 || comma > 256) return null;
  const header = value.slice(5, comma).toLowerCase();
  if (!header.split(";").includes("base64")) return null;
  return comma + 1;
}

function isLikelyBase64ImageField(key: string, value: string): boolean {
  if (value.length < BASE64_PLACEHOLDER_MIN_LENGTH) return false;
  const normalizedKey = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
  if (!BASE64_FIELD_NAMES.has(normalizedKey)) return false;
  const sample = value.slice(0, BASE64_SAMPLE_LENGTH);
  return /^[A-Za-z0-9+/=_-]+$/.test(sample);
}

function formatApproxKb(length: number): string {
  return `${Math.max(1, Math.round(length / 1024))}KB`;
}

function toSummary(entry: RequestLogEntry): RequestLogSummary {
  let estimatedCostUsd = 0;
  for (const call of entry.llmCalls) {
    if (call.estimatedCostUsd !== undefined) estimatedCostUsd += call.estimatedCostUsd;
  }
  const summary: RequestLogSummary = {
    requestId: entry.requestId,
    guildId: entry.guildId,
    channelId: entry.channelId,
    authorUsername: entry.authorUsername,
    trigger: entry.trigger,
    triggerContext: entry.triggerContext,
    agentRan: entry.agentRan,
    toolCount: entry.tools.length,
    runtimeActionCount: entry.tools.filter((tool) => tool.modelRequestId === undefined).length,
    llmCallCount: entry.llmCalls.length,
    estimatedCostUsd: estimatedCostUsd > 0 ? estimatedCostUsd : null,
    totalDurationMs: entry.totalDurationMs,
    hasError: entry.error !== undefined,
    timestamp: entry.timestamp,
  };
  if (entry.status !== undefined) summary.status = entry.status;
  return summary;
}

const logDir = process.env.LOG_DIR;
const logFile = logDir !== undefined && logDir !== "" ? `${logDir}/request-log.json` : undefined;
export const requestLogStore = new RequestLogStore(1000, logFile);
