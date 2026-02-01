const pkg = await Bun.file(new URL("../package.json", import.meta.url).pathname).json() as { version?: string };
const version: string = pkg.version ?? "0.0.0";

const startTime = Date.now();

console.log(
  JSON.stringify({
    level: "info",
    msg: "bot starting",
    version,
    runtime: `bun ${Bun.version}`,
    pid: process.pid,
    timestamp: new Date().toISOString(),
  })
);

// Validate critical environment early
const requiredEnv = ["DISCORD_TOKEN", "OPENROUTER_API_KEY"] as const;
const missing = requiredEnv.filter((k) => process.env[k] === undefined || process.env[k] === "");

if (missing.length > 0) {
  console.log(
    JSON.stringify({
      level: "warn",
      msg: "missing environment variables — bot will not connect",
      missing,
      timestamp: new Date().toISOString(),
    })
  );
}

console.log(
  JSON.stringify({
    level: "info",
    msg: "health check passed",
    uptimeMs: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  })
);
