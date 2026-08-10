import { Database as BunDatabase, type Statement } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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

export interface RequestLogTotals {
  requestCount: number;
  groupCount: number;
  estimatedCostUsd: number | null;
  firstRecordedAt: string | null;
}

export interface RequestLogGroupPage {
  groups: RequestLogGroupSummary[];
  totals: RequestLogTotals;
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

interface RequestLogGroupKey {
  groupId: string;
  scope: "message" | "trigger";
  sourceMessageId?: string;
}

interface StoredRequestSummary {
  key: RequestLogGroupKey;
  summary: RequestLogSummary;
}

interface StoredRequestDetail extends StoredRequestSummary {
  entry: RequestLogEntry;
}

interface StoredLogRow {
  group_id: string;
  group_scope: "message" | "trigger";
  source_message_id: string | null;
  summary_json: string;
}

interface StoredDetailRow extends StoredLogRow {
  entry_json: string;
}

interface LogFilterQuery {
  where: string;
  and: string;
  params: string[];
}

type InsertRequestLogParams = [
  string,
  string,
  "message" | "trigger",
  string | null,
  string,
  string,
  string,
  string,
  number | null,
  string,
  string,
];

interface StoredGroupKeyRow {
  group_id: string;
  group_scope: "message" | "trigger";
  source_message_id: string | null;
}

/** Stores live requests in memory and completed dashboard logs in indexed SQLite rows. */
export class RequestLogStore {
  private readonly db: BunDatabase;
  private readonly insertEntry: Statement<unknown, InsertRequestLogParams>;
  private readonly findGroupKey: Statement<StoredGroupKeyRow, [string]>;
  private activeRequests = 0;
  private readonly activeEntries = new Map<string, RequestLogEntry>();

  constructor(dbPath = ":memory:") {
    this.db = new BunDatabase(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
    this.db.run(`CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL UNIQUE,
      group_id TEXT NOT NULL,
      group_scope TEXT NOT NULL CHECK (group_scope IN ('message', 'trigger')),
      source_message_id TEXT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      author_username TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      estimated_cost_usd REAL,
      summary_json TEXT NOT NULL,
      entry_json TEXT NOT NULL
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS request_logs_timestamp ON request_logs(timestamp DESC, id DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS request_logs_group ON request_logs(group_id, timestamp, id)");
    this.db.run("CREATE INDEX IF NOT EXISTS request_logs_guild_timestamp ON request_logs(guild_id, timestamp DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS request_logs_channel_timestamp ON request_logs(channel_id, timestamp DESC)");
    this.db.run("CREATE INDEX IF NOT EXISTS request_logs_author_timestamp ON request_logs(author_username, timestamp DESC)");
    this.db.run(`CREATE INDEX IF NOT EXISTS request_logs_filters_timestamp
      ON request_logs(guild_id, channel_id, author_username, timestamp DESC)`);
    this.insertEntry = this.db.prepare<unknown, InsertRequestLogParams>(`INSERT INTO request_logs
      (request_id, group_id, group_scope, source_message_id, guild_id, channel_id,
       author_username, timestamp, estimated_cost_usd, summary_json, entry_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET
        group_id = excluded.group_id,
        group_scope = excluded.group_scope,
        source_message_id = excluded.source_message_id,
        guild_id = excluded.guild_id,
        channel_id = excluded.channel_id,
        author_username = excluded.author_username,
        timestamp = excluded.timestamp,
        estimated_cost_usd = excluded.estimated_cost_usd,
        summary_json = excluded.summary_json,
        entry_json = excluded.entry_json`);
    this.findGroupKey = this.db.prepare<StoredGroupKeyRow, [string]>(`SELECT group_id, group_scope, source_message_id
      FROM request_logs WHERE request_id = ?`);
  }

  push(entry: RequestLogEntry): void {
    const key = this.requestGroupKey(entry);
    const summary = toSummary(entry);
    const storedEntry = sanitizeDashboardLogEntry(entry);
    this.insertEntry.run(
      entry.requestId,
      key.groupId,
      key.scope,
      key.sourceMessageId ?? null,
      entry.guildId,
      entry.channelId,
      entry.authorUsername,
      entry.timestamp,
      summary.estimatedCostUsd,
      JSON.stringify(summary),
      JSON.stringify(storedEntry),
    );
    this.activeEntries.delete(entry.requestId);
  }

  query(filters: RequestLogFilters = {}, limit?: number): RequestLogEntry[] {
    if (limit !== undefined && limit <= 0) return [];
    const active = this.matchingActiveEntries(filters);
    const remaining = limit === undefined ? undefined : Math.max(0, limit - active.length);
    if (remaining === 0) return active.slice(0, limit);
    const filter = requestLogFilterQuery(filters);
    const limitSql = remaining === undefined ? "" : " LIMIT ?";
    const params: Array<string | number> = [...filter.params];
    if (remaining !== undefined) params.push(remaining);
    const rows = this.db.prepare(`SELECT entry_json FROM request_logs${filter.where}
      ORDER BY timestamp DESC, id DESC${limitSql}`).all(...params) as Array<{ entry_json: string }>;
    return [...active, ...rows.map((row) => JSON.parse(row.entry_json) as RequestLogEntry)];
  }

  /** Returns compact rows for the dashboard list without large tool or LLM payloads. */
  querySummaries(filters: RequestLogFilters = {}, limit?: number): RequestLogSummary[] {
    if (limit !== undefined && limit <= 0) return [];
    const active = this.matchingActiveEntries(filters).map((entry) => toSummary(entry));
    const remaining = limit === undefined ? undefined : Math.max(0, limit - active.length);
    if (remaining === 0) return active.slice(0, limit);
    const filter = requestLogFilterQuery(filters);
    const limitSql = remaining === undefined ? "" : " LIMIT ?";
    const params: Array<string | number> = [...filter.params];
    if (remaining !== undefined) params.push(remaining);
    const rows = this.db.prepare(`SELECT summary_json FROM request_logs${filter.where}
      ORDER BY timestamp DESC, id DESC${limitSql}`).all(...params) as Array<{ summary_json: string }>;
    return [...active, ...rows.map((row) => JSON.parse(row.summary_json) as RequestLogSummary)];
  }

  /** Groups all request phases rooted in the same Discord message or synthetic trigger. */
  queryGroups(filters: RequestLogFilters = {}, limit?: number): RequestLogGroupSummary[] {
    if (limit !== undefined && limit <= 0) return [];
    const filter = requestLogFilterQuery(filters);
    const limitSql = limit === undefined ? "" : " LIMIT ?";
    const params: Array<string | number> = [...filter.params];
    if (limit !== undefined) params.push(limit);
    const groupRows = this.db.prepare(`SELECT group_id FROM request_logs${filter.where}
      GROUP BY group_id ORDER BY MIN(timestamp) DESC${limitSql}`).all(...params) as Array<{ group_id: string }>;
    const active = this.matchingActiveSummaries(filters);
    const groupIds = new Set([...groupRows.map((row) => row.group_id), ...active.map((item) => item.key.groupId)]);
    const stored = groupIds.size === 0 ? [] : this.storedSummaries([...groupIds], filter);
    const groups = groupRequestSummaries([...stored, ...active]);
    return limit === undefined ? groups : groups.slice(0, limit);
  }

  /** Returns the recent lifecycle page and totals across every matching request. */
  queryGroupPage(filters: RequestLogFilters = {}, limit?: number): RequestLogGroupPage {
    return {
      groups: this.queryGroups(filters, limit),
      totals: this.queryTotals(filters),
    };
  }

  /** Returns every full request phase belonging to one dashboard group. */
  getSanitizedGroup(groupId: string): RequestLogGroupDetail | null {
    const rows = this.db.prepare(`SELECT group_id, group_scope, source_message_id, summary_json, entry_json
      FROM request_logs WHERE group_id = ? ORDER BY timestamp, id`).all(groupId) as StoredDetailRow[];
    const active = [...this.activeEntries.values()]
      .filter((entry) => this.requestGroupKey(entry).groupId === groupId)
      .map((entry): StoredRequestDetail => ({
        key: this.requestGroupKey(entry),
        summary: toSummary(withLiveActiveDurations(entry)),
        entry: sanitizeDashboardLogEntry(withLiveActiveDurations(entry)),
      }));
    const stored = rows.map((row) => storedRequestDetail(row));
    const items = [...stored, ...active].sort((a, b) => a.summary.timestamp.localeCompare(b.summary.timestamp));
    const group = groupRequestSummaries(items)[0];
    if (group === undefined) return null;
    return {
      ...group,
      entries: items.map((item) => ({ summary: item.summary, entry: item.entry })),
    };
  }

  /** Finds one full dashboard log entry by request ID for on-demand expansion. */
  getByRequestId(requestId: string): RequestLogEntry | null {
    const active = this.activeEntries.get(requestId);
    if (active !== undefined) return withLiveActiveDurations(active);
    const row = this.db.prepare("SELECT entry_json FROM request_logs WHERE request_id = ?")
      .get(requestId) as { entry_json: string } | null;
    return row === null ? null : JSON.parse(row.entry_json) as RequestLogEntry;
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
    const storedGuildIds = this.db.prepare("SELECT DISTINCT guild_id FROM request_logs").all() as Array<{ guild_id: string }>;
    const storedChannelIds = this.db.prepare("SELECT DISTINCT channel_id FROM request_logs").all() as Array<{ channel_id: string }>;
    const storedUsernames = this.db.prepare("SELECT DISTINCT author_username FROM request_logs").all() as Array<{ author_username: string }>;
    for (const row of storedGuildIds) guildIds.add(row.guild_id);
    for (const row of storedChannelIds) channelIds.add(row.channel_id);
    for (const row of storedUsernames) usernames.add(row.author_username);
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

  close(): void {
    this.db.close();
  }

  private matchingActiveEntries(filters: RequestLogFilters): RequestLogEntry[] {
    return [...this.activeEntries.values()]
      .filter((entry) => entryMatchesFilters(entry, filters))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .map((entry) => withLiveActiveDurations(entry));
  }

  private matchingActiveSummaries(filters: RequestLogFilters): StoredRequestSummary[] {
    return this.matchingActiveEntries(filters).map((entry) => ({
      key: this.requestGroupKey(entry),
      summary: toSummary(entry),
    }));
  }

  private storedSummaries(groupIds: string[], filter: LogFilterQuery): StoredRequestSummary[] {
    const placeholders = groupIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT group_id, group_scope, source_message_id, summary_json
      FROM request_logs WHERE group_id IN (${placeholders})${filter.and}
      ORDER BY timestamp, id`).all(...groupIds, ...filter.params) as StoredLogRow[];
    return rows.map((row) => storedRequestSummary(row));
  }

  private queryTotals(filters: RequestLogFilters): RequestLogTotals {
    const filter = requestLogFilterQuery(filters);
    const row = this.db.prepare(`SELECT COUNT(*) AS request_count,
        COUNT(DISTINCT group_id) AS group_count,
        COUNT(estimated_cost_usd) AS cost_count,
        SUM(estimated_cost_usd) AS estimated_cost_usd,
        MIN(timestamp) AS first_recorded_at
      FROM request_logs${filter.where}`).get(...filter.params) as {
        request_count: number;
        group_count: number;
        cost_count: number;
        estimated_cost_usd: number | null;
        first_recorded_at: string | null;
      };
    const active = this.matchingActiveSummaries(filters);
    const activeGroupIds = [...new Set(active.map((item) => item.key.groupId))];
    let groupCount = row.group_count;
    if (activeGroupIds.length > 0) {
      const placeholders = activeGroupIds.map(() => "?").join(", ");
      const existing = this.db.prepare(`SELECT DISTINCT group_id FROM request_logs
        WHERE group_id IN (${placeholders})${filter.and}`)
        .all(...activeGroupIds, ...filter.params) as Array<{ group_id: string }>;
      const existingIds = new Set(existing.map((item) => item.group_id));
      groupCount += activeGroupIds.filter((groupId) => !existingIds.has(groupId)).length;
    }
    const activeCosts = active.flatMap((item) => item.summary.estimatedCostUsd === null
      ? []
      : [item.summary.estimatedCostUsd]);
    const firstRecordedAt = active.reduce<string | null>((first, item) => (
      first === null || item.summary.timestamp < first ? item.summary.timestamp : first
    ), row.first_recorded_at);
    return {
      requestCount: row.request_count + active.length,
      groupCount,
      estimatedCostUsd: row.cost_count + activeCosts.length === 0
        ? null
        : (row.estimated_cost_usd ?? 0) + activeCosts.reduce((total, cost) => total + cost, 0),
      firstRecordedAt,
    };
  }

  private requestGroupKey(
    entry: RequestLogEntry,
    visitedRequestIds: ReadonlySet<string> = new Set(),
  ): RequestLogGroupKey {
    const trigger = isRecord(entry.trigger) ? entry.trigger : undefined;
    if (typeof trigger?.jobId === "string" && trigger.jobId !== "") {
      return { groupId: `job:${trigger.jobId}`, scope: "trigger" };
    }
    const sourceRequestId = typeof trigger?.sourceRequestId === "string" ? trigger.sourceRequestId : undefined;
    if (sourceRequestId !== undefined && !visitedRequestIds.has(sourceRequestId)) {
      const sourceActive = this.activeEntries.get(sourceRequestId);
      if (sourceActive !== undefined) {
        return this.requestGroupKey(sourceActive, new Set([...visitedRequestIds, entry.requestId]));
      }
      const source = this.findGroupKey.get(sourceRequestId);
      if (source !== null) return storedGroupKey(source);
    }
    return directRequestLogGroupKey(entry);
  }
}

function requestLogFilterQuery(filters: RequestLogFilters): LogFilterQuery {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filters.guildId !== undefined) {
    conditions.push("guild_id = ?");
    params.push(filters.guildId);
  }
  if (filters.channelId !== undefined) {
    conditions.push("channel_id = ?");
    params.push(filters.channelId);
  }
  if (filters.authorUsername !== undefined) {
    conditions.push("author_username = ?");
    params.push(filters.authorUsername);
  }
  const expression = conditions.join(" AND ");
  return {
    where: expression === "" ? "" : ` WHERE ${expression}`,
    and: expression === "" ? "" : ` AND ${expression}`,
    params,
  };
}

function storedGroupKey(row: Pick<StoredLogRow, "group_id" | "group_scope" | "source_message_id">): RequestLogGroupKey {
  return {
    groupId: row.group_id,
    scope: row.group_scope,
    ...(row.source_message_id !== null ? { sourceMessageId: row.source_message_id } : {}),
  };
}

function storedRequestSummary(row: StoredLogRow): StoredRequestSummary {
  return {
    key: storedGroupKey(row),
    summary: JSON.parse(row.summary_json) as RequestLogSummary,
  };
}

function storedRequestDetail(row: StoredDetailRow): StoredRequestDetail {
  return {
    ...storedRequestSummary(row),
    entry: JSON.parse(row.entry_json) as RequestLogEntry,
  };
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
    if (/^\[\d+KB base64 truncated\]$/.test(value.slice(dataUri))) return value;
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

function groupRequestSummaries(items: StoredRequestSummary[]): RequestLogGroupSummary[] {
  const grouped = new Map<string, StoredRequestSummary[]>();
  for (const item of items) {
    const current = grouped.get(item.key.groupId) ?? [];
    current.push(item);
    grouped.set(item.key.groupId, current);
  }

  return [...grouped.entries()].map(([groupId, groupItems]) => {
    const orderedItems = [...groupItems].sort((a, b) => a.summary.timestamp.localeCompare(b.summary.timestamp));
    const requests = orderedItems.map((item) => item.summary);
    const primary = requests.find((summary) => summary.triggerContext?.content?.trim() !== "") ?? requests[0];
    if (primary === undefined) throw new Error(`Dashboard group ${groupId} has no entries.`);
    const key = orderedItems[0]?.key;
    if (key === undefined) throw new Error(`Dashboard group ${groupId} has no key.`);
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

function directRequestLogGroupKey(entry: RequestLogEntry): RequestLogGroupKey {
  const trigger = isRecord(entry.trigger) ? entry.trigger : undefined;
  if (typeof trigger?.jobId === "string" && trigger.jobId !== "") {
    return { groupId: `job:${trigger.jobId}`, scope: "trigger" };
  }
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
if (logDir !== undefined && logDir !== "") mkdirSync(logDir, { recursive: true });
const logDatabasePath = logDir === undefined || logDir === "" ? ":memory:" : join(logDir, "request-logs.db");
export const requestLogStore = new RequestLogStore(logDatabasePath);
