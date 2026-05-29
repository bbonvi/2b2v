#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createDatabase } from "../src/db/database.ts";
import { buildMessageEmbeddingBlocks, fetchMessageEmbeddingSources } from "../src/embeddings/message-text.ts";

const BATCH_SIZE = 512;

interface Args {
  guildId: string;
  channelId?: string;
  configPath: string;
  dbPath?: string;
  dataDir?: string;
  qdrantUrl?: string;
  modelCacheDir?: string;
  since?: number;
  before?: number;
  apply: boolean;
}

interface MinimalConfig {
  dataDir?: string;
  qdrantUrl?: string;
  modelCacheDir?: string;
}

function usage(): never {
  console.error(`Usage:
  bun scripts/reindex-message-vectors.ts --guild <guild-id> [--channel <channel-id>] [--dry-run]
  bun scripts/reindex-message-vectors.ts --guild <guild-id> [--channel <channel-id>] --apply

Rebuilds message vectors from SQLite using current normalization and merged-message blocks.
In --apply mode, matching existing message vectors are deleted first, then rebuilt.

Options:
  --guild <id>              Target guild ID. Required.
  --channel <id>            Optional channel ID.
  --since <date>            Only rows at/after date.
  --before <date>           Only rows before date.
  --config <path>           Minimal config YAML path. Default: config/config.yaml.
  --db <path>               SQLite DB path. Default: <dataDir>/bot.db.
  --data-dir <path>         Data dir fallback if --db is omitted.
  --qdrant-url <url>        Qdrant URL fallback.
  --model-cache-dir <path>  Embedding model cache dir fallback.
  --dry-run                 Count only. Default.
  --apply                   Delete matching vectors and rebuild them.`);
  process.exit(2);
}

function readOption(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseDate(value: string, flag: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${flag} must be a valid date`);
  return parsed;
}

function parseArgs(argv: string[]): Args {
  let guildId: string | undefined;
  let channelId: string | undefined;
  let configPath = "config/config.yaml";
  let dbPath: string | undefined;
  let dataDir: string | undefined;
  let qdrantUrl: string | undefined;
  let modelCacheDir: string | undefined;
  let since: number | undefined;
  let before: number | undefined;
  let apply = false;

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
        since = parseDate(readOption(argv, i, arg), arg);
        i++;
        break;
      case "--before":
        before = parseDate(readOption(argv, i, arg), arg);
        i++;
        break;
      case "--apply":
        apply = true;
        break;
      case "--dry-run":
        apply = false;
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
  return { guildId, channelId, configPath, dbPath, dataDir, qdrantUrl, modelCacheDir, since, before, apply };
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

function buildBaseDeleteMust(args: Args): Array<Record<string, unknown>> {
  const must: Array<Record<string, unknown>> = [
    { key: "type", match: { value: "message" } },
    { key: "guild_id", match: { value: args.guildId } },
  ];
  if (args.channelId !== undefined) must.push({ key: "channel_id", match: { value: args.channelId } });
  return must;
}

function buildDeleteFilters(args: Args): Array<Record<string, unknown>> {
  const base = buildBaseDeleteMust(args);
  if (args.since !== undefined || args.before !== undefined) {
    const byCreatedRange: Record<string, number> = {};
    if (args.since !== undefined) byCreatedRange.gte = args.since;
    if (args.before !== undefined) byCreatedRange.lt = args.before;
    const filters: Array<Record<string, unknown>> = [
      { must: [...base, { key: "created_at", range: byCreatedRange }] },
    ];

    if (args.since !== undefined) {
      const overlapMust = [
        ...base,
        { key: "last_created_at", range: { gte: args.since } },
      ];
      if (args.before !== undefined) {
        overlapMust.push({ key: "created_at", range: { lt: args.before } });
      }
      filters.push({ must: overlapMust });
    }

    return filters;
  }
  return [{ must: base }];
}

function blockOverlapsRange(block: ReturnType<typeof buildMessageEmbeddingBlocks>[number], args: Args): boolean {
  return (args.since === undefined || block.lastCreatedAt >= args.since)
    && (args.before === undefined || block.createdAt < args.before);
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));
  const runtime = resolveRuntime(args);
  const db = createDatabase(runtime.dbPath);
  try {
    const allSources = fetchMessageEmbeddingSources(db, {
      guildId: args.guildId,
      channelId: args.channelId,
    });
    const allBlocks = buildMessageEmbeddingBlocks(allSources);
    const blocks = allBlocks.filter((block) => blockOverlapsRange(block, args));
    const sourceMessageCount = blocks.reduce((sum, block) => sum + block.messageCount, 0);
    console.log(`SQLite messages scanned: ${allSources.length}`);
    console.log(`Vector source messages: ${sourceMessageCount}`);
    console.log(`Embedding blocks: ${blocks.length}`);
    console.log(`Merged blocks: ${blocks.filter((block) => block.messageCount > 1).length}`);

    if (!args.apply) return;

    const { getEmbeddingPipeline, disposePipeline } = await import("../src/embeddings/pipeline.ts");
    const { createEmbeddingQueue } = await import("../src/embeddings/queue.ts");
    const { createQdrantClient, ensureCollection, healthCheck, COLLECTION_NAME } = await import("../src/qdrant/client.ts");
    const qdrant = createQdrantClient({ url: runtime.qdrantUrl });
    if (!(await healthCheck(qdrant))) throw new Error(`Qdrant is not reachable at ${runtime.qdrantUrl}`);
    await ensureCollection(qdrant);
    for (const filter of buildDeleteFilters(args)) {
      await qdrant.delete(COLLECTION_NAME, { wait: true, filter });
    }
    console.log("Deleted matching existing message vectors.");

    const pipeline = await getEmbeddingPipeline({ cacheDir: runtime.modelCacheDir });
    const queue = createEmbeddingQueue(pipeline, qdrant);
    try {
      for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
        const batch = blocks.slice(i, i + BATCH_SIZE);
        await queue.enqueueBatch(batch.map((block) => ({
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
            source: "reindex",
            embedding_kind: block.messageCount > 1 ? "merged" : "single",
          },
        })));
        await queue.flush();
        console.log(`Reindexed blocks: ${Math.min(i + batch.length, blocks.length)}/${blocks.length}`);
      }
      await queue.shutdown();
    } finally {
      await disposePipeline();
    }
  } finally {
    db.close();
  }
}

try {
  await main();
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Reindex failed: ${message}`);
  process.exit(1);
}
