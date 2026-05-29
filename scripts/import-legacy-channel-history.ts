#!/usr/bin/env bun
import { Database as BunDatabase } from "bun:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Database } from "../src/db/database.ts";
import { buildMessageEmbeddingBlocks, type MessageEmbeddingSource } from "../src/embeddings/message-text.ts";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const QDRANT_COLLECTION_NAME = "embeddings";
const DEFAULT_PAGE_SIZE = 100;
const EMBED_PROGRESS_CHUNK = 512;
const MAX_EMBED_ATTEMPTS = 3;
const abortController = new AbortController();

interface Args {
  guildId: string;
  channelId: string;
  discordToken?: string;
  botUserId?: string;
  configPath: string;
  dbPath?: string;
  dataDir?: string;
  qdrantUrl?: string;
  modelCacheDir?: string;
  since?: number;
  maxMessages?: number;
  apply: boolean;
  checkQdrant: boolean;
  quiet: boolean;
}

interface MinimalConfig {
  dataDir?: string;
  qdrantUrl?: string;
  modelCacheDir?: string;
}

interface DiscordUser {
  id: string;
  username: string;
  bot?: boolean;
}

interface DiscordMessage {
  id: string;
  author: DiscordUser;
  content: string;
  timestamp: string;
}

interface ImportRow {
  id: string;
  guildId: string;
  channelId: string;
  userId: string;
  authorUsername: string;
  content: string;
  isBot: boolean;
  createdAt: number;
}

interface FetchStats {
  pages: number;
  fetched: number;
  duplicateIds: number;
  candidateRows: number;
  existingRows: number;
  changedRows: number;
  skippedEmpty: number;
  skippedInvalidDate: number;
  skippedOutsideRange: number;
  users: Map<string, number>;
  botMessages: number;
  minDate?: number;
  maxDate?: number;
  stopReason: string;
}

interface ExistingResult {
  existing: number;
  missing: ImportRow[];
}

interface OldestStoredMessage {
  id: string;
  createdAt: number;
}

interface RuntimePaths {
  dbPath: string;
  qdrantUrl: string;
  modelCacheDir: string;
}

interface StreamingImporter {
  importRows(rows: ImportRow[]): Promise<void>;
  close(): Promise<void>;
}

function usage(): never {
  console.error(`Usage:
  bun scripts/import-legacy-channel-history.ts --guild <guild-id> --channel <channel-id> [--dry-run]
  bun scripts/import-legacy-channel-history.ts --guild <guild-id> --channel <channel-id> --apply

Options:
  --guild <id>               Target guild ID. Required.
  --channel <id>             Discord channel ID to fetch and import. Required.
  --token <token>            Discord bot token. Defaults to DISCORD_TOKEN.
  --bot-user-id <id>         Current bot user ID. Defaults to /users/@me from the token.
  --since <date>             Stop once fetched messages are older than this date.
  --max-messages <n>         Stop after roughly n fetched Discord messages.
  --config <path>            Minimal config YAML path. Default: config/config.yaml.
  --db <path>                SQLite DB path. Default: <dataDir>/bot.db.
  --data-dir <path>          Data dir fallback if --db is omitted.
  --qdrant-url <url>         Qdrant URL fallback. Default: env QDRANT_URL, config, then http://localhost:6333.
  --model-cache-dir <path>   Embedding model cache dir fallback.
  --check-qdrant             In dry-run, verify Qdrant health too.
  --quiet                    Suppress progress logs.
  --dry-run                  Fetch/validate/count only. Default.
  --apply                    Insert missing rows and embed only inserted rows.`);
  process.exit(2);
}

function sleep(ms: number, signal: AbortSignal = abortController.signal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("Cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Cancelled"));
    }, { once: true });
  });
}

function readOption(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseDateOption(value: string, flag: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${flag} must be a valid date`);
  return parsed;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function abortSignalWithTimeout(parent: AbortSignal, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  controller.signal.addEventListener("abort", () => {
    clearTimeout(timer);
    parent.removeEventListener("abort", onAbort);
  }, { once: true });
  return controller.signal;
}

function parseArgs(argv: string[]): Args {
  let guildId: string | undefined;
  let channelId: string | undefined;
  let discordToken: string | undefined;
  let botUserId: string | undefined;
  let configPath = "config/config.yaml";
  let dbPath: string | undefined;
  let dataDir: string | undefined;
  let qdrantUrl: string | undefined;
  let modelCacheDir: string | undefined;
  let since: number | undefined;
  let maxMessages: number | undefined;
  let apply = false;
  let checkQdrant = false;
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case "--guild":
        guildId = readOption(argv, i, arg);
        i++;
        break;
      case "--channel":
        channelId = readOption(argv, i, arg);
        i++;
        break;
      case "--token":
        discordToken = readOption(argv, i, arg);
        i++;
        break;
      case "--bot-user-id":
        botUserId = readOption(argv, i, arg);
        i++;
        break;
      case "--config":
        configPath = readOption(argv, i, arg);
        i++;
        break;
      case "--db":
        dbPath = readOption(argv, i, arg);
        i++;
        break;
      case "--data-dir":
        dataDir = readOption(argv, i, arg);
        i++;
        break;
      case "--qdrant-url":
        qdrantUrl = readOption(argv, i, arg);
        i++;
        break;
      case "--model-cache-dir":
        modelCacheDir = readOption(argv, i, arg);
        i++;
        break;
      case "--since":
        since = parseDateOption(readOption(argv, i, arg), arg);
        i++;
        break;
      case "--max-messages":
        maxMessages = parsePositiveInteger(readOption(argv, i, arg), arg);
        i++;
        break;
      case "--apply":
        apply = true;
        break;
      case "--dry-run":
        apply = false;
        break;
      case "--check-qdrant":
        checkQdrant = true;
        break;
      case "--quiet":
        quiet = true;
        break;
      case "--help":
      case "-h":
        usage();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (guildId === undefined || guildId === "") throw new Error("--guild is required");
  if (channelId === undefined || channelId === "") throw new Error("--channel is required");

  return {
    guildId,
    channelId,
    discordToken: discordToken ?? process.env.DISCORD_TOKEN,
    botUserId: botUserId ?? process.env.BOT_USER_ID ?? process.env.DISCORD_CLIENT_ID,
    configPath,
    dbPath,
    dataDir,
    qdrantUrl,
    modelCacheDir,
    since,
    maxMessages,
    apply,
    checkQdrant,
    quiet,
  };
}

function readMinimalConfig(configPath: string): MinimalConfig {
  if (!existsSync(configPath)) return {};
  const parsed = parseYaml(readFileSync(configPath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) return {};
  const raw = parsed as Record<string, unknown>;
  return {
    dataDir: typeof raw.dataDir === "string" ? raw.dataDir : undefined,
    qdrantUrl: typeof raw.qdrantUrl === "string" ? raw.qdrantUrl : undefined,
    modelCacheDir: typeof raw.modelCacheDir === "string" ? raw.modelCacheDir : undefined,
  };
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "n/a";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GiB`;
}

function fileSize(path: string): number | undefined {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

function cgroupNumber(paths: string[]): number | undefined {
  for (const path of paths) {
    try {
      const value = Number(readFileSync(path, "utf8").trim());
      if (Number.isFinite(value)) return value;
    } catch {
      // try next cgroup layout
    }
  }
  return undefined;
}

function runtimeTelemetry(dbPath: string): string {
  const dbBytes = fileSize(dbPath);
  const walBytes = fileSize(`${dbPath}-wal`);
  const shmBytes = fileSize(`${dbPath}-shm`);
  const memoryBytes = cgroupNumber([
    "/sys/fs/cgroup/memory.current",
    "/sys/fs/cgroup/memory/memory.usage_in_bytes",
  ]);
  const cpuMicros = cgroupCpuMicros();
  return [
    `sqlite=${formatBytes(dbBytes)}`,
    `wal=${formatBytes(walBytes)}`,
    `shm=${formatBytes(shmBytes)}`,
    `mem=${formatBytes(memoryBytes)}`,
    cpuMicros !== undefined ? `cpu=${(cpuMicros / 1_000_000).toFixed(1)}s` : "cpu=n/a",
  ].join(", ");
}

function cgroupCpuMicros(): number | undefined {
  try {
    const stat = readFileSync("/sys/fs/cgroup/cpu.stat", "utf8");
    const match = /^usage_usec\s+(\d+)$/m.exec(stat);
    if (match?.[1] !== undefined) return Number(match[1]);
  } catch {
    // try cgroup v1 below
  }
  const nanos = cgroupNumber(["/sys/fs/cgroup/cpuacct/cpuacct.usage"]);
  return nanos !== undefined ? nanos / 1000 : undefined;
}

function resolveRuntime(args: Args): RuntimePaths {
  const cfg = readMinimalConfig(args.configPath);
  const dataDir = args.dataDir ?? process.env.DATA_DIR ?? cfg.dataDir ?? "data";
  return {
    dbPath: args.dbPath ?? join(dataDir, "bot.db"),
    qdrantUrl: args.qdrantUrl ?? process.env.QDRANT_URL ?? cfg.qdrantUrl ?? "http://localhost:6333",
    modelCacheDir: args.modelCacheDir ?? process.env.MODEL_CACHE_DIR ?? cfg.modelCacheDir ?? "model-cache",
  };
}

function readBotUserIdFromDatabase(dbPath: string): string | undefined {
  if (!existsSync(dbPath)) return undefined;
  const raw = new BunDatabase(dbPath, { readonly: true });
  try {
    const row = raw
      .prepare(
        `SELECT user_id
         FROM messages
         WHERE author_username = '2B' AND is_bot = 1 AND user_id NOT LIKE 'legacy:%'
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get() as { user_id: string } | null;
    return row?.user_id;
  } finally {
    raw.close();
  }
}

function readOldestStoredMessage(dbPath: string, guildId: string, channelId: string): OldestStoredMessage | undefined {
  if (!existsSync(dbPath)) return undefined;
  const raw = new BunDatabase(dbPath, { readonly: true });
  try {
    const row = raw
      .prepare(
        `SELECT id, created_at
         FROM messages
         WHERE guild_id = ? AND channel_id = ? AND is_synthetic = 0
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
      )
      .get(guildId, channelId) as { id: string; created_at: number } | null;
    if (row === null) return undefined;
    return { id: row.id, createdAt: row.created_at };
  } finally {
    raw.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function retryAfterMs(response: Response, body: unknown): number {
  if (isRecord(body) && typeof body.retry_after === "number" && Number.isFinite(body.retry_after)) {
    return Math.ceil(body.retry_after * 1000) + 100;
  }
  const header = response.headers.get("retry-after") ?? response.headers.get("x-ratelimit-reset-after");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000) + 100;
  }
  return 1000;
}

async function maybeSleepAfterSuccess(response: Response): Promise<void> {
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (remaining !== "0") return;
  const resetAfter = response.headers.get("x-ratelimit-reset-after");
  if (resetAfter === null) return;
  const seconds = Number(resetAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  await sleep(Math.ceil(seconds * 1000) + 50);
}

async function discordJson<T>(path: string, token: string, signal: AbortSignal = abortController.signal): Promise<T> {
  const url = `${DISCORD_API_BASE}${path}`;
  let attempt = 0;

  while (true) {
    if (signal.aborted) throw new Error("Cancelled");
    attempt++;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bot ${token}`,
        "User-Agent": "2b2v-history-backfill/1.0",
      },
      signal: abortSignalWithTimeout(signal, 30_000),
    });

    if (response.ok) {
      await maybeSleepAfterSuccess(response);
      return await response.json() as T;
    }

    const body = await response.json().catch((): unknown => undefined);
    if (response.status === 429) {
      await sleep(retryAfterMs(response, body), signal);
      continue;
    }

    if (response.status >= 500 && response.status < 600 && attempt < 6) {
      await sleep(Math.min(10_000, 500 * 2 ** (attempt - 1)), signal);
      continue;
    }

    const detail = isRecord(body) && typeof body.message === "string" ? `: ${body.message}` : "";
    throw new Error(`Discord API ${response.status} ${response.statusText}${detail}`);
  }
}

async function fetchBotUserId(token: string, signal: AbortSignal = abortController.signal): Promise<string> {
  const user = await discordJson<DiscordUser>("/users/@me", token, signal);
  return user.id;
}

async function fetchMessagePage(input: {
  token: string;
  channelId: string;
  beforeMessageId?: string;
  limit: number;
  signal?: AbortSignal;
}): Promise<DiscordMessage[]> {
  const params = new URLSearchParams({ limit: String(input.limit) });
  if (input.beforeMessageId !== undefined) params.set("before", input.beforeMessageId);
  return await discordJson<DiscordMessage[]>(
    `/channels/${encodeURIComponent(input.channelId)}/messages?${params.toString()}`,
    input.token,
    input.signal,
  );
}

function makeEmptyStats(stopReason = "channel exhausted"): FetchStats {
  return {
    pages: 0,
    fetched: 0,
    duplicateIds: 0,
    candidateRows: 0,
    existingRows: 0,
    changedRows: 0,
    skippedEmpty: 0,
    skippedInvalidDate: 0,
    skippedOutsideRange: 0,
    users: new Map<string, number>(),
    botMessages: 0,
    minDate: undefined,
    maxDate: undefined,
    stopReason,
  };
}

async function processHistory(input: {
  args: Args;
  runtime: RuntimePaths;
  token: string;
  botUserId: string;
}): Promise<FetchStats> {
  const { args, runtime, token, botUserId } = input;
  const users = new Map<string, number>();
  const seenIds = new Set<string>();
  const oldestStored = readOldestStoredMessage(runtime.dbPath, args.guildId, args.channelId);
  let beforeMessageId = oldestStored?.id;
  let pages = 0;
  let fetched = 0;
  let duplicateIds = 0;
  let candidateRows = 0;
  let existingRows = 0;
  let changedRows = 0;
  let skippedEmpty = 0;
  let skippedInvalidDate = 0;
  let skippedOutsideRange = 0;
  let botMessages = 0;
  let minDate: number | undefined;
  let maxDate: number | undefined;
  let stopReason = "channel exhausted";

  if (args.since !== undefined && oldestStored !== undefined && oldestStored.createdAt <= args.since) {
    return makeEmptyStats(`oldest stored message is already at/before since (${new Date(args.since).toISOString()})`);
  }

  let db: Database | Pick<Database, "raw"> | undefined;
  let writeDb: Database | undefined;
  let closeDb: (() => void) | undefined;
  let importer: StreamingImporter | undefined;
  if (args.apply) {
    const { createDatabase } = await import("../src/db/database.ts");
    const createdDb = createDatabase(runtime.dbPath);
    writeDb = createdDb;
    db = createdDb;
    closeDb = () => createdDb.close();
  } else if (existsSync(runtime.dbPath)) {
    const readonlyDb = new BunDatabase(runtime.dbPath, { readonly: true });
    db = { raw: readonlyDb };
    closeDb = () => readonlyDb.close();
  }

  if (!args.quiet) {
    const cursor = oldestStored !== undefined
      ? ` before oldest stored message ${oldestStored.id} (${formatDate(oldestStored.createdAt)})`
      : " from newest message because no stored history exists";
    console.log(`Fetching Discord history for channel ${args.channelId}${cursor}...`);
  }

  try {
    while (true) {
      if (abortController.signal.aborted) throw new Error("Cancelled");
      if (args.maxMessages !== undefined && fetched >= args.maxMessages) {
        stopReason = `max messages reached (${args.maxMessages})`;
        break;
      }

      const remaining = args.maxMessages !== undefined ? args.maxMessages - fetched : DEFAULT_PAGE_SIZE;
      const limit = Math.max(1, Math.min(DEFAULT_PAGE_SIZE, remaining));
      const page = await fetchMessagePage({
        token,
        channelId: args.channelId,
        beforeMessageId,
        limit,
        signal: abortController.signal,
      });

      pages++;
      if (page.length === 0) break;

      const pageCandidates: ImportRow[] = [];
      let oldestInPage: number | undefined;
      for (const message of page) {
        if (seenIds.has(message.id)) {
          duplicateIds++;
          continue;
        }
        seenIds.add(message.id);
        fetched++;

        const createdAt = Date.parse(message.timestamp);
        if (Number.isNaN(createdAt)) {
          skippedInvalidDate++;
          continue;
        }

        oldestInPage = oldestInPage === undefined ? createdAt : Math.min(oldestInPage, createdAt);
        if (args.since !== undefined && createdAt < args.since) {
          skippedOutsideRange++;
          continue;
        }

        const content = message.content.trim();
        if (content === "") {
          skippedEmpty++;
          continue;
        }

        const isBot = message.author.bot === true || message.author.id === botUserId;
        if (isBot) botMessages++;
        users.set(message.author.username, (users.get(message.author.username) ?? 0) + 1);
        minDate = minDate === undefined ? createdAt : Math.min(minDate, createdAt);
        maxDate = maxDate === undefined ? createdAt : Math.max(maxDate, createdAt);
        pageCandidates.push({
          id: message.id,
          guildId: args.guildId,
          channelId: args.channelId,
          userId: message.author.id,
          authorUsername: message.author.username,
          content,
          isBot,
          createdAt,
        });
      }

      const existing = db !== undefined ? getExisting(db, pageCandidates) : { existing: 0, missing: pageCandidates };
      candidateRows += pageCandidates.length;
      existingRows += existing.existing;
      changedRows += existing.missing.length;
      if (args.apply && existing.missing.length > 0) {
        if (writeDb === undefined) throw new Error("write database was not initialized");
        importer ??= await createStreamingImporter(writeDb, runtime.qdrantUrl, runtime.modelCacheDir, args.quiet);
        await importer.importRows(existing.missing);
      }

      if (!args.quiet) {
        const action = args.apply ? "imported" : "would_import";
        const qdrant = await qdrantTelemetry(runtime.qdrantUrl);
        console.log(
          `Page ${pages}: messages=${fetched}, candidates=${candidateRows}, ${action}=${changedRows}, oldest=${formatDate(oldestInPage)} | ${runtimeTelemetry(runtime.dbPath)} | ${qdrant}`,
        );
      }

      const last = page[page.length - 1];
      if (last === undefined) break;
      beforeMessageId = last.id;

      if (args.since !== undefined && oldestInPage !== undefined && oldestInPage < args.since) {
        stopReason = `since boundary reached (${new Date(args.since).toISOString()})`;
        break;
      }
    }
  } finally {
    await importer?.close();
    closeDb?.();
  }

  return {
    pages,
    fetched,
    duplicateIds,
    candidateRows,
    existingRows,
    changedRows,
    skippedEmpty,
    skippedInvalidDate,
    skippedOutsideRange,
    users,
    botMessages,
    minDate,
    maxDate,
    stopReason,
  };
}

function getExisting(db: Pick<Database, "raw">, rows: ImportRow[]): ExistingResult {
  const stmt = db.raw.prepare("SELECT 1 FROM messages WHERE id = ? LIMIT 1");
  const missing: ImportRow[] = [];
  let existing = 0;
  for (const row of rows) {
    const found = stmt.get(row.id) as unknown;
    if (found === null) missing.push(row);
    else existing++;
  }
  return { existing, missing };
}

function insertRows(db: Database, rows: ImportRow[]): void {
  const stmt = db.raw.prepare(
    `INSERT OR IGNORE INTO messages
      (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id, is_synthetic, related_thread_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL)`,
  );

  const insertMany = db.raw.transaction((items: ImportRow[]) => {
    for (const row of items) {
      stmt.run(
        row.id,
        row.guildId,
        row.channelId,
        row.userId,
        row.authorUsername,
        row.content,
        row.content,
        row.isBot ? 1 : 0,
        row.createdAt,
      );
    }
  });
  insertMany(rows);
}

async function createStreamingImporter(
  db: Database,
  qdrantUrl: string,
  modelCacheDir: string,
  quiet: boolean,
): Promise<StreamingImporter> {
  const { getEmbeddingPipeline, disposePipeline } = await import("../src/embeddings/pipeline.ts");
  const { createEmbeddingQueue } = await import("../src/embeddings/queue.ts");
  const { createQdrantClient, ensureCollection, healthCheck } = await import("../src/qdrant/client.ts");
  const qdrant = createQdrantClient({ url: qdrantUrl });
  if (!(await healthCheck(qdrant))) {
    throw new Error(`Qdrant is not reachable at ${qdrantUrl}`);
  }
  await ensureCollection(qdrant);

  const pipeline = await getEmbeddingPipeline({ cacheDir: modelCacheDir });
  const queue = createEmbeddingQueue(pipeline, qdrant);

  let imported = 0;
  return {
    async importRows(rows: ImportRow[]): Promise<void> {
      if (rows.length === 0) return;
      const sources: MessageEmbeddingSource[] = rows.map((row) => ({
        id: row.id,
        guildId: row.guildId,
        channelId: row.channelId,
        userId: row.userId,
        content: row.content,
        createdAt: row.createdAt,
        isBot: row.isBot,
      }));
      const blocks = buildMessageEmbeddingBlocks(sources);
      for (let i = 0; i < blocks.length; i += EMBED_PROGRESS_CHUNK) {
        const chunk = blocks.slice(i, i + EMBED_PROGRESS_CHUNK);
        const messageIds = new Set(chunk.flatMap((block) => block.messageIds));
        const rowsToInsert = rows.filter((row) => messageIds.has(row.id));
        insertRows(db, rowsToInsert);
        imported += rowsToInsert.length;
        for (let attempt = 1; attempt <= MAX_EMBED_ATTEMPTS; attempt++) {
          try {
            await queue.enqueueBatch(chunk.map((block) => ({
              id: block.id,
              text: block.text,
              target: "message",
              metadata: {
                guild_id: block.guildId,
                channel_id: block.channelId,
                user_id: block.userId,
                message_id: block.firstMessageId,
                message_ids: block.messageIds,
                first_message_id: block.firstMessageId,
                last_message_id: block.lastMessageId,
                message_count: block.messageCount,
                created_at: block.createdAt,
                last_created_at: block.lastCreatedAt,
                is_bot: block.isBot,
                source: "backfill",
                embedding_kind: block.messageCount > 1 ? "merged" : "single",
              },
            })));
            await queue.flush();
            break;
          } catch (err) {
            if (attempt >= MAX_EMBED_ATTEMPTS) {
              const message = err instanceof Error ? err.message : String(err);
              throw new Error(`Embedding failed after ${MAX_EMBED_ATTEMPTS} attempts: ${message}`);
            }
            if (!quiet) {
              const message = err instanceof Error ? err.message : String(err);
              console.warn(`Embedding chunk failed; retrying (${attempt}/${MAX_EMBED_ATTEMPTS}): ${message}`);
            }
            await sleep(1000 * attempt);
          }
        }
        if (!quiet) console.log(`Imported rows: ${imported}`);
      }
    },

    async close(): Promise<void> {
      try {
        await queue.shutdown();
      } finally {
        await disposePipeline();
      }
    },
  };
}

function formatDate(ms: number | undefined): string {
  if (ms === undefined) return "(none)";
  return new Date(ms).toISOString();
}

function formatTopUsers(users: Map<string, number>): string {
  return [...users.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => `${name}:${count}`)
    .join(", ");
}

async function dryRun(args: Args, runtime: { dbPath: string; qdrantUrl: string }, stats: FetchStats): Promise<void> {
  console.log("Mode: dry-run");
  console.log(`Discord pages fetched: ${stats.pages}`);
  console.log(`Discord messages fetched: ${stats.fetched}`);
  console.log(`Candidate rows: ${stats.candidateRows}`);
  console.log(`Candidate date range: ${formatDate(stats.minDate)} .. ${formatDate(stats.maxDate)}`);
  console.log(`Users: ${formatTopUsers(stats.users)}`);
  console.log(`Bot/self rows: ${stats.botMessages}`);
  console.log(`Existing rows: ${stats.existingRows}`);
  console.log(`Would insert/embed: ${stats.changedRows}`);
  console.log(`Skipped: empty=${stats.skippedEmpty}, invalid_date=${stats.skippedInvalidDate}, outside_range=${stats.skippedOutsideRange}, duplicate_ids=${stats.duplicateIds}`);
  console.log(`Stop reason: ${stats.stopReason}`);

  if (!existsSync(runtime.dbPath)) {
    console.log(`Database: missing at ${runtime.dbPath}; --apply would create/open it`);
  } else {
    console.log(`Database: ${runtime.dbPath}`);
  }

  if (args.checkQdrant) {
    console.log(`Qdrant: ${(await qdrantHttpHealthCheck(runtime.qdrantUrl)) ? "reachable" : "unreachable"} at ${runtime.qdrantUrl}`);
  }
}

function printApplySummary(stats: FetchStats): void {
  console.log("Mode: apply");
  console.log(`Discord pages fetched: ${stats.pages}`);
  console.log(`Discord messages fetched: ${stats.fetched}`);
  console.log(`Candidate rows: ${stats.candidateRows}`);
  console.log(`Imported rows: ${stats.changedRows}`);
  console.log(`Skipped existing rows: ${stats.existingRows}`);
  console.log(`Candidate date range: ${formatDate(stats.minDate)} .. ${formatDate(stats.maxDate)}`);
  console.log(`Skipped: empty=${stats.skippedEmpty}, invalid_date=${stats.skippedInvalidDate}, outside_range=${stats.skippedOutsideRange}, duplicate_ids=${stats.duplicateIds}`);
  console.log(`Stop reason: ${stats.stopReason}`);
}

async function qdrantHttpHealthCheck(qdrantUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${qdrantUrl.replace(/\/$/, "")}/healthz`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function qdrantTelemetry(qdrantUrl: string): Promise<string> {
  try {
    const base = qdrantUrl.replace(/\/$/, "");
    const response = await fetch(`${base}/collections/${QDRANT_COLLECTION_NAME}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return "qdrant=n/a";
    const body = await response.json() as unknown;
    if (!isRecord(body) || !isRecord(body.result)) return "qdrant=n/a";
    const result = body.result;
    const points = typeof result.points_count === "number" ? result.points_count : undefined;
    const indexed = typeof result.indexed_vectors_count === "number" ? result.indexed_vectors_count : undefined;
    const vectors = typeof result.vectors_count === "number" ? result.vectors_count : undefined;
    const status = typeof result.status === "string" ? result.status : undefined;
    const optimizer = typeof result.optimizer_status === "string" ? result.optimizer_status : undefined;
    return [
      `qdrant_points=${points ?? "n/a"}`,
      `vectors=${vectors ?? "n/a"}`,
      `indexed=${indexed ?? "n/a"}`,
      `qdrant_status=${status ?? "n/a"}`,
      `optimizer=${optimizer ?? "n/a"}`,
    ].join(", ");
  } catch {
    return "qdrant=n/a";
  }
}

async function main(): Promise<void> {
  for (const signalName of ["SIGINT", "SIGTERM"] as const) {
    process.on(signalName, () => {
      if (!abortController.signal.aborted) {
        console.error(`Received ${signalName}; cancelling...`);
        abortController.abort(new Error("Cancelled"));
      }
    });
  }

  const args = parseArgs(Bun.argv.slice(2));
  if (args.discordToken === undefined || args.discordToken === "") {
    throw new Error("Discord token is required; pass --token or set DISCORD_TOKEN");
  }

  const runtime = resolveRuntime(args);
  const storedBotUserId = args.botUserId ?? readBotUserIdFromDatabase(runtime.dbPath);
  if (storedBotUserId === undefined && !args.quiet) {
    console.log("Resolving bot user via Discord /users/@me...");
  }
  const botUserId = storedBotUserId ?? await fetchBotUserId(args.discordToken, abortController.signal);
  const effectiveArgs: Args = { ...args, botUserId };
  const stats = await processHistory({
    args: effectiveArgs,
    runtime,
    token: args.discordToken,
    botUserId,
  });

  if (effectiveArgs.apply) printApplySummary(stats);
  else await dryRun(effectiveArgs, runtime, stats);
}

try {
  await main();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (message === "Cancelled" || abortController.signal.aborted) {
    console.error("Import cancelled.");
    process.exit(130);
  }
  console.error(`Import failed: ${message}`);
  process.exit(1);
}
