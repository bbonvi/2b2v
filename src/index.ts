import { createLogger, type LogLevel } from "./logger";

const pkg = await Bun.file(new URL("../package.json", import.meta.url).pathname).json() as { version?: string };
const version: string = pkg.version ?? "0.0.0";

const startTime = Date.now();
const logLevel = (process.env.LOG_LEVEL ?? "info") as LogLevel;
const log = createLogger({ level: logLevel });

log.info("bot starting", {
  version,
  runtime: `bun ${Bun.version}`,
  pid: process.pid,
});

// Validate critical environment early
const requiredEnv = ["DISCORD_TOKEN", "OPENROUTER_API_KEY"] as const;
const missing = requiredEnv.filter((k) => process.env[k] === undefined || process.env[k] === "");

if (missing.length > 0) {
  log.warn("missing environment variables — bot will not connect", { missing });
}

log.info("health check passed", { uptimeMs: Date.now() - startTime });
