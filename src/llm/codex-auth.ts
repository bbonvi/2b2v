import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

const CODEX_PROVIDER_ID = "openai-codex";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readAuthFile(path: string): Record<string, OAuthCredential> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Codex auth file is not a JSON object: ${path}`);
  }
  return parsed as Record<string, OAuthCredential>;
}

function writeAuthFile(path: string, credentials: Record<string, OAuthCredential>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Resolve and refresh an OpenAI Codex OAuth access token from the configured auth file. */
export async function getCodexApiKey(authPath: string): Promise<string> {
  const auth = readAuthFile(authPath);
  const stored = auth[CODEX_PROVIDER_ID];
  if (stored?.type !== "oauth") {
    throw new Error(
      `OpenAI Codex OAuth credentials are missing. Run: bun run codex:login -- --auth ${authPath}`,
    );
  }

  const oauth = openaiCodexProvider().auth.oauth;
  if (oauth === undefined) {
    throw new Error("OpenAI Codex OAuth is unavailable");
  }
  const credentials = Date.now() >= stored.expires ? await oauth.refresh(stored) : stored;
  const resolved = await oauth.toAuth(credentials);
  if (resolved.apiKey === undefined || resolved.apiKey === "") {
    throw new Error("OpenAI Codex OAuth did not produce an access token");
  }

  if (credentials !== stored) {
    auth[CODEX_PROVIDER_ID] = credentials;
    writeAuthFile(authPath, auth);
  }
  return resolved.apiKey;
}
