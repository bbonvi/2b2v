#!/usr/bin/env bun
import { Database as BunDatabase } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createDatabase, type Database } from "../src/db/database.ts";
import { getEmbeddingPipeline, disposePipeline } from "../src/embeddings/pipeline.ts";
import { createEmbeddingQueue } from "../src/embeddings/queue.ts";
import { createQdrantClient, ensureCollection, healthCheck } from "../src/qdrant/client.ts";

const DEFAULT_DAYS = 30;

interface Args {
  filePath: string;
  guildId: string;
  channelId: string;
  botUserId?: string;
  configPath: string;
  dbPath?: string;
  dataDir?: string;
  qdrantUrl?: string;
  modelCacheDir?: string;
  days?: number;
  since?: number;
  until?: number;
  limit?: number;
  apply: boolean;
  checkQdrant: boolean;
}

interface MinimalConfig {
  dataDir?: string;
  qdrantUrl?: string;
  modelCacheDir?: string;
}

interface LegacyMessage {
  id: string;
  username: string;
  content: string;
  createdAt: number;
  deleted: boolean;
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

interface ScanResult {
  total: number;
  candidates: ImportRow[];
  skippedDeleted: number;
  skippedEmpty: number;
  skippedInvalidId: number;
  skippedInvalidDate: number;
  skippedOutsideRange: number;
  skippedByLimit: number;
  botMessages: number;
  users: Map<string, number>;
  minDate?: number;
  maxDate?: number;
}

interface ExistingResult {
  existing: number;
  missing: ImportRow[];
}

function usage(): never {
  console.error(`Usage:
  bun scripts/import-legacy-channel-history.ts <legacy-json> --guild <guild-id> --channel <channel-id> [--dry-run]
  bun scripts/import-legacy-channel-history.ts <legacy-json> --guild <guild-id> --channel <channel-id> --apply

Options:
  --guild <id>              Target guild ID. Required.
  --channel <id>            Target channel ID. Required.
  --bot-user-id <id>        User ID for legacy 2B messages. Defaults to BOT_USER_ID, DISCORD_CLIENT_ID, or decoded DISCORD_TOKEN.
  --days <n>                Import only messages from the last n days. Default: ${DEFAULT_DAYS}. Use --all to disable.
  --since <date>            Import messages at/after date. Overrides --days.
  --until <date>            Import messages before date.
  --limit <n>               Cap candidate rows after filtering, useful for test runs.
  --config <path>           Minimal config YAML path. Default: config/config.yaml.
  --db <path>               SQLite DB path. Default: <dataDir>/bot.db.
  --data-dir <path>         Data dir fallback if --db is omitted.
  --qdrant-url <url>        Qdrant URL fallback. Default: env QDRANT_URL, config, then http://localhost:6333.
  --model-cache-dir <path>  Embedding model cache dir fallback.
  --check-qdrant            In dry-run, verify Qdrant health too.
  --dry-run                 Read/validate/count only. Default.
  --apply                   Insert missing rows and embed only inserted rows.`);
  process.exit(2);
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

function parseArgs(argv: string[]): Args {
  let filePath: string | undefined;
  let guildId: string | undefined;
  let channelId: string | undefined;
  let botUserId: string | undefined;
  let configPath = "config/config.yaml";
  let dbPath: string | undefined;
  let dataDir: string | undefined;
  let qdrantUrl: string | undefined;
  let modelCacheDir: string | undefined;
  let days: number | undefined = DEFAULT_DAYS;
  let since: number | undefined;
  let until: number | undefined;
  let limit: number | undefined;
  let apply = false;
  let checkQdrant = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("--") && filePath === undefined) {
      filePath = arg;
      continue;
    }

    switch (arg) {
      case "--guild":
        guildId = readOption(argv, i, arg);
        i++;
        break;
      case "--channel":
        channelId = readOption(argv, i, arg);
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
      case "--days":
        days = parsePositiveInteger(readOption(argv, i, arg), arg);
        since = undefined;
        i++;
        break;
      case "--since":
        since = parseDateOption(readOption(argv, i, arg), arg);
        days = undefined;
        i++;
        break;
      case "--until":
        until = parseDateOption(readOption(argv, i, arg), arg);
        i++;
        break;
      case "--limit":
        limit = parsePositiveInteger(readOption(argv, i, arg), arg);
        i++;
        break;
      case "--all":
        days = undefined;
        since = undefined;
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
      case "--help":
      case "-h":
        usage();
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (filePath === undefined) throw new Error("legacy JSON path is required");
  if (guildId === undefined || guildId === "") throw new Error("--guild is required");
  if (channelId === undefined || channelId === "") throw new Error("--channel is required");

  return {
    filePath,
    guildId,
    channelId,
    botUserId: botUserId ?? readBotUserIdFromEnv(),
    configPath,
    dbPath,
    dataDir,
    qdrantUrl,
    modelCacheDir,
    days,
    since,
    until,
    limit,
    apply,
    checkQdrant,
  };
}

function readBotUserIdFromEnv(): string | undefined {
  if (process.env.BOT_USER_ID !== undefined && process.env.BOT_USER_ID !== "") return process.env.BOT_USER_ID;
  if (process.env.DISCORD_CLIENT_ID !== undefined && process.env.DISCORD_CLIENT_ID !== "") return process.env.DISCORD_CLIENT_ID;

  const token = process.env.DISCORD_TOKEN;
  if (token === undefined || token === "") return undefined;
  const firstSegment = token.split(".")[0];
  if (firstSegment === undefined || firstSegment === "") return undefined;

  try {
    const decoded = Buffer.from(firstSegment, "base64url").toString("utf8");
    return /^\d+$/.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
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

function resolveRuntime(args: Args): { dbPath: string; qdrantUrl: string; modelCacheDir: string } {
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

function normalizeUnsafeDiscordIds(jsonText: string): string {
  return jsonText.replace(
    /"(message_id|reference_id)"\s*:\s*(\d{15,})/g,
    (_match: string, key: string, id: string) => `"${key}":"${id}"`,
  );
}

function readLegacyMessages(filePath: string): LegacyMessage[] {
  const rawText = readFileSync(filePath, "utf8");
  const normalized = normalizeUnsafeDiscordIds(rawText);
  const parsed = JSON.parse(normalized) as unknown;
  if (typeof parsed !== "object" || parsed === null || !("messages" in parsed)) {
    throw new Error("legacy JSON must be an object with a messages array");
  }
  const messages = (parsed as { messages: unknown }).messages;
  if (!Array.isArray(messages)) throw new Error("legacy JSON messages must be an array");

  return messages.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      return { id: "", username: "", content: "", createdAt: Number.NaN, deleted: true };
    }
    const raw = entry as Record<string, unknown>;
    const idRaw = raw.message_id;
    const dateRaw = raw.date;
    return {
      id: typeof idRaw === "string" ? idRaw : "",
      username: typeof raw.user_name === "string" ? raw.user_name : `unknown-${index}`,
      content: typeof raw.content === "string" ? raw.content : "",
      createdAt: typeof dateRaw === "string" ? Date.parse(dateRaw) : Number.NaN,
      deleted: raw.deleted === true,
    };
  });
}

function isBotUsername(username: string): boolean {
  return username === "2B";
}

function userIdFor(username: string, botUserId: string | undefined): string {
  if (username === "2B" && botUserId !== undefined) return botUserId;
  return `legacy:${username}`;
}

function scanMessages(args: Args, messages: LegacyMessage[]): ScanResult {
  const since = args.since ?? (args.days !== undefined ? Date.now() - args.days * 24 * 60 * 60 * 1000 : undefined);
  const users = new Map<string, number>();
  const candidates: ImportRow[] = [];
  let skippedDeleted = 0;
  let skippedEmpty = 0;
  let skippedInvalidId = 0;
  let skippedInvalidDate = 0;
  let skippedOutsideRange = 0;
  let skippedByLimit = 0;
  let botMessages = 0;
  let minDate: number | undefined;
  let maxDate: number | undefined;

  for (const message of messages) {
    if (message.deleted) {
      skippedDeleted++;
      continue;
    }
    if (!/^\d+$/.test(message.id)) {
      skippedInvalidId++;
      continue;
    }
    if (Number.isNaN(message.createdAt)) {
      skippedInvalidDate++;
      continue;
    }
    if ((since !== undefined && message.createdAt < since) || (args.until !== undefined && message.createdAt >= args.until)) {
      skippedOutsideRange++;
      continue;
    }

    const content = message.content.trim();
    if (content === "") {
      skippedEmpty++;
      continue;
    }
    if (args.limit !== undefined && candidates.length >= args.limit) {
      skippedByLimit++;
      continue;
    }

    const isBot = isBotUsername(message.username);
    if (isBot) botMessages++;
    users.set(message.username, (users.get(message.username) ?? 0) + 1);
    minDate = minDate === undefined ? message.createdAt : Math.min(minDate, message.createdAt);
    maxDate = maxDate === undefined ? message.createdAt : Math.max(maxDate, message.createdAt);
    candidates.push({
      id: message.id,
      guildId: args.guildId,
      channelId: args.channelId,
      userId: userIdFor(message.username, args.botUserId),
      authorUsername: message.username,
      content,
      isBot,
      createdAt: message.createdAt,
    });
  }

  return {
    total: messages.length,
    candidates,
    skippedDeleted,
    skippedEmpty,
    skippedInvalidId,
    skippedInvalidDate,
    skippedOutsideRange,
    skippedByLimit,
    botMessages,
    users,
    minDate,
    maxDate,
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

async function embedRows(rows: ImportRow[], qdrantUrl: string, modelCacheDir: string): Promise<void> {
  if (rows.length === 0) return;
  const qdrant = createQdrantClient({ url: qdrantUrl });
  if (!(await healthCheck(qdrant))) {
    throw new Error(`Qdrant is not reachable at ${qdrantUrl}`);
  }
  await ensureCollection(qdrant);

  const pipeline = await getEmbeddingPipeline({ cacheDir: modelCacheDir });
  const queue = createEmbeddingQueue(pipeline, qdrant);
  try {
    await queue.enqueueBatch(rows.map((row) => ({
      id: row.id,
      text: row.content,
      target: "message",
      metadata: {
        guild_id: row.guildId,
        channel_id: row.channelId,
        user_id: row.userId,
        created_at: row.createdAt,
      },
    })));
    await queue.shutdown();
  } finally {
    await disposePipeline();
  }
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

async function dryRun(args: Args, runtime: { dbPath: string; qdrantUrl: string }, scan: ScanResult): Promise<void> {
  console.log("Mode: dry-run");
  console.log(`Input messages: ${scan.total}`);
  console.log(`Candidate rows: ${scan.candidates.length}`);
  console.log(`Date range: ${formatDate(scan.minDate)} .. ${formatDate(scan.maxDate)}`);
  console.log(`Users: ${formatTopUsers(scan.users)}`);
  console.log(`Bot/self rows: ${scan.botMessages}${args.botUserId === undefined ? " (2B bot user id unresolved; pass --bot-user-id or DISCORD_TOKEN)" : ""}`);
  console.log(`Skipped: deleted=${scan.skippedDeleted}, empty=${scan.skippedEmpty}, invalid_id=${scan.skippedInvalidId}, invalid_date=${scan.skippedInvalidDate}, outside_range=${scan.skippedOutsideRange}, over_limit=${scan.skippedByLimit}`);

  if (!existsSync(runtime.dbPath)) {
    console.log(`Database: missing at ${runtime.dbPath}; --apply would create/open it`);
  } else {
    const raw = new BunDatabase(runtime.dbPath, { readonly: true });
    try {
      const existing = getExisting({ raw }, scan.candidates);
      console.log(`Database: ${runtime.dbPath}`);
      console.log(`Existing rows: ${existing.existing}`);
      console.log(`Would insert/embed: ${existing.missing.length}`);
    } finally {
      raw.close();
    }
  }

  if (args.checkQdrant) {
    const qdrant = createQdrantClient({ url: runtime.qdrantUrl });
    console.log(`Qdrant: ${(await healthCheck(qdrant)) ? "reachable" : "unreachable"} at ${runtime.qdrantUrl}`);
  }
}

async function applyImport(args: Args, runtime: { dbPath: string; qdrantUrl: string; modelCacheDir: string }, scan: ScanResult): Promise<void> {
  const db = createDatabase(runtime.dbPath);
  try {
    const before = getExisting(db, scan.candidates);
    insertRows(db, before.missing);
    console.log(`Inserted rows: ${before.missing.length}`);
    console.log(`Skipped existing rows: ${before.existing}`);
    console.log(`Embedding rows: ${before.missing.length}`);
    await embedRows(before.missing, runtime.qdrantUrl, runtime.modelCacheDir);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  if (!existsSync(args.filePath)) throw new Error(`legacy JSON not found: ${args.filePath}`);
  const runtime = resolveRuntime(args);
  const effectiveArgs: Args = {
    ...args,
    botUserId: args.botUserId ?? readBotUserIdFromDatabase(runtime.dbPath),
  };
  const messages = readLegacyMessages(args.filePath);
  const scan = scanMessages(effectiveArgs, messages);

  if (effectiveArgs.apply) {
    await applyImport(effectiveArgs, runtime, scan);
  } else {
    await dryRun(effectiveArgs, runtime, scan);
  }
}

try {
  await main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Import failed: ${message}`);
  process.exit(1);
}
