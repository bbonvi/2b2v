#!/usr/bin/env bun
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { loginOpenAICodex } from "@mariozechner/pi-ai";

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

const authPath = argValue("--auth") ?? process.env.CODEX_AUTH_PATH ?? "data/codex-auth.json";
const rl = createInterface({ input, output });

try {
  const credentials = await loginOpenAICodex({
    onAuth: (info) => {
      console.log("\nOpen this URL to authorize OpenAI Codex:");
      console.log(info.url);
      if (info.instructions !== undefined && info.instructions !== "") {
        console.log(`\n${info.instructions}`);
      }
    },
    onPrompt: async (prompt) => {
      const suffix = prompt.allowEmpty === true ? " (optional)" : "";
      return await rl.question(`${prompt.message}${suffix}: `);
    },
    onProgress: (message) => console.log(message),
    onManualCodeInput: async () => await rl.question("Paste the authorization code here if the browser callback does not complete: "),
    originator: "2b2v",
  });

  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(
    authPath,
    `${JSON.stringify({ "openai-codex": { type: "oauth", ...credentials } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(authPath, 0o600);
  console.log(`\nCodex credentials saved to ${authPath}`);
} finally {
  rl.close();
}
