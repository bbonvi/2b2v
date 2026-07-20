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
  outcome: RequestLogOutcome;
  status?: "active";
  timestamp: string;
}

export type RequestLogOutcome = "default" | "effective" | "error" | "active";

export interface RequestLogGroupSummary {
  groupId: string;
  scope: "message" | "trigger";
  sourceMessageId?: string;
  guildId: string;
  channelId: string;
  authorUsername: string;
  triggerContext?: RequestTriggerContext;
  requests: RequestLogSummary[];
  requestCount: number;
  toolCount: number;
  runtimeActionCount: number;
  llmCallCount: number;
  estimatedCostUsd: number | null;
  totalDurationMs: number;
  outcome: RequestLogOutcome;
  timestamp: string;
}

export interface RequestLogGroupDetail extends RequestLogGroupSummary {
  entries: Array<{ summary: RequestLogSummary; entry: RequestLogEntry }>;
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
    const completed: Array<{ entry: RequestLogEntry; order: number }> = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + this.maxEntries) % this.maxEntries;
      const entry = this.entries[idx] as RequestLogEntry;
      if (!entryMatchesFilters(entry, filters)) continue;
      completed.push({ entry, order: this.count - i });
    }
    completed.sort((a, b) => {
      const byTime = b.entry.timestamp.localeCompare(a.entry.timestamp);
      return byTime !== 0 ? byTime : b.order - a.order;
    });
    for (const item of completed) {
      result.push(item.entry);
      if (limit !== undefined && result.length >= limit) break;
    }
    return result;
  }

  /** Returns compact rows for the dashboard list without large tool or LLM payloads. */
  querySummaries(filters: RequestLogFilters = {}, limit?: number): RequestLogSummary[] {
    return this.query(filters, limit).map((entry) => toSummary(entry));
  }

  /** Groups all request phases rooted in the same Discord message or synthetic trigger. */
  queryGroups(filters: RequestLogFilters = {}, limit?: number): RequestLogGroupSummary[] {
    const groups = groupRequestLogs(this.query(filters));
    return limit === undefined ? groups : groups.slice(0, Math.max(0, limit));
  }

  /** Returns every full request phase belonging to one dashboard group. */
  getSanitizedGroup(groupId: string): RequestLogGroupDetail | null {
    const group = groupRequestLogs(this.query()).find((candidate) => candidate.groupId === groupId);
    if (group === undefined) return null;
    const entries = group.requests.flatMap((summary) => {
      const entry = this.getSanitizedByRequestId(summary.requestId);
      return entry === null ? [] : [{ summary, entry }];
    });
    return { ...group, entries };
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
      resultPayload: sanitizeDashboardValue(tool.resultPayload, "resultPayload"),
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
    outcome: requestLogOutcome(entry),
    timestamp: entry.timestamp,
  };
  if (entry.status !== undefined) summary.status = entry.status;
  return summary;
}

function groupRequestLogs(entries: RequestLogEntry[]): RequestLogGroupSummary[] {
  const grouped = new Map<string, RequestLogEntry[]>();
  for (const entry of entries) {
    const key = requestLogGroupKey(entry);
    const current = grouped.get(key.groupId) ?? [];
    current.push(entry);
    grouped.set(key.groupId, current);
  }

  return [...grouped.entries()].map(([groupId, groupEntries]) => {
    const orderedEntries = [...groupEntries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const requests = orderedEntries.map((entry) => toSummary(entry));
    const primary = orderedEntries.find((entry) => entry.triggerContext?.content?.trim() !== "") ?? orderedEntries[0];
    if (primary === undefined) throw new Error(`Dashboard group ${groupId} has no entries.`);
    const key = requestLogGroupKey(primary);
    const estimatedCost = requests.reduce((total, request) => total + (request.estimatedCostUsd ?? 0), 0);
    return {
      groupId,
      scope: key.scope,
      ...(key.sourceMessageId !== undefined ? { sourceMessageId: key.sourceMessageId } : {}),
      guildId: primary.guildId,
      channelId: primary.channelId,
      authorUsername: primary.triggerContext?.authorUsername ?? primary.authorUsername,
      ...(primary.triggerContext !== undefined ? { triggerContext: primary.triggerContext } : {}),
      requests,
      requestCount: requests.length,
      toolCount: requests.reduce((total, request) => total + request.toolCount, 0),
      runtimeActionCount: requests.reduce((total, request) => total + request.runtimeActionCount, 0),
      llmCallCount: requests.reduce((total, request) => total + request.llmCallCount, 0),
      estimatedCostUsd: estimatedCost > 0 ? estimatedCost : null,
      totalDurationMs: requests.reduce((total, request) => total + request.totalDurationMs, 0),
      outcome: combinedOutcome(requests.map((request) => request.outcome)),
      timestamp: requests[0]?.timestamp ?? primary.timestamp,
    };
  }).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function requestLogGroupKey(entry: RequestLogEntry): {
  groupId: string;
  scope: "message" | "trigger";
  sourceMessageId?: string;
} {
  const trigger = isRecord(entry.trigger) ? entry.trigger : undefined;
  const triggerSourceMessageId = typeof trigger?.sourceMessageId === "string" ? trigger.sourceMessageId : undefined;
  const sourceMessageId = entry.triggerContext?.messageId
    ?? entry.triggerContext?.sourceMessageId
    ?? triggerSourceMessageId;
  const syntheticTrigger = entry.authorUsername === "scheduler"
    || entry.triggerContext?.authorUsername === "scheduler"
    || trigger?.type === "ambient_initiative_evaluator";
  if (sourceMessageId !== undefined && sourceMessageId !== "" && !syntheticTrigger) {
    return {
      groupId: `message:${entry.guildId}:${entry.channelId}:${sourceMessageId}`,
      scope: "message",
      sourceMessageId,
    };
  }
  if (sourceMessageId !== undefined && sourceMessageId !== "") {
    return {
      groupId: `trigger:${entry.guildId}:${entry.channelId}:${sourceMessageId}`,
      scope: "trigger",
    };
  }
  return { groupId: `trigger:${entry.requestId}`, scope: "trigger" };
}

function requestLogOutcome(entry: RequestLogEntry): RequestLogOutcome {
  if (entry.error !== undefined || entry.tools.some((tool) => tool.isError === true || tool.status === "error")) return "error";
  if (entry.status === "active") return "active";
  for (const tool of entry.tools) {
    if (tool.status === "skipped" || tool.status === "error" || tool.isError === true) continue;
    const payload = isRecord(tool.resultPayload) ? tool.resultPayload : undefined;
    const details = isRecord(payload?.details) ? payload.details : undefined;
    const structured = isRecord(payload?.structuredContent) ? payload.structuredContent : undefined;
    if (tool.tool === "record_memory" && typeof details?.applied === "number" && details.applied > 0) return "effective";
    if (tool.tool === "record_relationship" && Array.isArray(details?.accepted) && details.accepted.length > 0) return "effective";
    if (tool.tool === "record_inner_threads" && typeof details?.applied === "number" && details.applied > 0) return "effective";
    if (tool.tool === "ambient_decision" && structured?.status === "selected") return "effective";
  }
  return "default";
}

function combinedOutcome(outcomes: readonly RequestLogOutcome[]): RequestLogOutcome {
  if (outcomes.includes("error")) return "error";
  if (outcomes.includes("active")) return "active";
  if (outcomes.includes("effective")) return "effective";
  return "default";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const logDir = process.env.LOG_DIR;
const logFile = logDir !== undefined && logDir !== "" ? `${logDir}/request-log.json` : undefined;
export const requestLogStore = new RequestLogStore(1000, logFile);
