import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { getOAuthApiKey, type OAuthCredentials } from "@earendil-works/pi-ai/oauth";

const CODEX_PROVIDER_ID = "openai-codex";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readAuthFile(path: string): Record<string, OAuthCredentials> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Codex auth file is not a JSON object: ${path}`);
  }
  return parsed as Record<string, OAuthCredentials>;
}

function writeAuthFile(path: string, credentials: Record<string, OAuthCredentials>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Resolve and refresh an OpenAI Codex OAuth access token from the configured auth file. */
export async function getCodexApiKey(authPath: string): Promise<string> {
  const auth = readAuthFile(authPath);
  const result = await getOAuthApiKey(CODEX_PROVIDER_ID, auth);
  if (result === null) {
    throw new Error(
      `OpenAI Codex OAuth credentials are missing. Run: bun run codex:login -- --auth ${authPath}`,
    );
  }

  auth[CODEX_PROVIDER_ID] = { type: "oauth", ...result.newCredentials };
  writeAuthFile(authPath, auth);
  return result.apiKey;
}
