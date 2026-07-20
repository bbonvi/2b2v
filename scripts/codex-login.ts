#!/usr/bin/env bun
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

const authPath = argValue("--auth") ?? process.env.CODEX_AUTH_PATH ?? "data/codex-auth.json";
const rl = createInterface({ input, output });

async function answerPrompt(prompt: AuthPrompt): Promise<string> {
  if (prompt.type === "select") {
    console.log(`\n${prompt.message}`);
    prompt.options.forEach((option, index) => {
      console.log(`${index + 1}. ${option.label}`);
    });
    const answer = await rl.question("Selection: ");
    const index = Number(answer) - 1;
    const selected = prompt.options[index];
    if (selected === undefined) {
      throw new Error("Invalid login method selection");
    }
    return selected.id;
  }
  return await rl.question(`${prompt.message}: `);
}

function notify(event: AuthEvent): void {
  if (event.type === "auth_url") {
    console.log("\nOpen this URL to authorize OpenAI Codex:");
    console.log(event.url);
    if (event.instructions !== undefined && event.instructions !== "") {
      console.log(`\n${event.instructions}`);
    }
    return;
  }
  if (event.type === "device_code") {
    console.log(`\nOpen ${event.verificationUri} and enter code ${event.userCode}`);
    return;
  }
  console.log(event.message);
  if (event.type === "info") {
    for (const link of event.links ?? []) {
      console.log(`${link.label ?? "More information"}: ${link.url}`);
    }
  }
}

try {
  const oauth = openaiCodexProvider().auth.oauth;
  if (oauth === undefined) {
    throw new Error("OpenAI Codex OAuth is unavailable");
  }
  const credentials = await oauth.login({
    prompt: answerPrompt,
    notify,
  });

  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(
    authPath,
    `${JSON.stringify({ "openai-codex": credentials }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(authPath, 0o600);
  console.log(`\nCodex credentials saved to ${authPath}`);
} finally {
  rl.close();
}
