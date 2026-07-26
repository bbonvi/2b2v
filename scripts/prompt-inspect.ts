import { join } from "path";
import { loadGlobalConfig, loadGuildConfigs, resolveGuildConfig } from "../src/config/loader.ts";
import { loadInstructionBundle } from "../src/config/instruction-bundle.ts";
import {
  inspectPromptScenario,
  isPromptScenarioId,
  promptScenarioSummaries,
  type PromptInspection,
  type PromptScenarioId,
} from "../src/config/prompt-inspector.ts";
import type { LlmProvider } from "../src/config/types.ts";
import type { Logger } from "../src/logger.ts";

type OutputFormat = "tree" | "assembled" | "json";

interface CliOptions {
  profile: string;
  scenario: PromptScenarioId;
  provider: LlmProvider;
  format: OutputFormat;
  guildId?: string;
  list: boolean;
}

function quietLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    logTokenUsage: () => {},
    child: () => quietLogger(),
  };
}

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(args: string[]): CliOptions {
  const configuredProfile = process.env.PROFILE?.trim();
  let profile = configuredProfile === undefined || configuredProfile === "" ? "2b" : configuredProfile;
  let scenario: PromptScenarioId = "discord";
  let provider: LlmProvider = "openai-codex";
  let format: OutputFormat = "tree";
  let guildId: string | undefined;
  let list = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--profile") {
      profile = nextValue(args, index, arg);
      index += 1;
    } else if (arg === "--surface" || arg === "--scenario") {
      const value = nextValue(args, index, arg);
      if (!isPromptScenarioId(value)) throw new Error(`Unknown prompt scenario: ${value}`);
      scenario = value;
      index += 1;
    } else if (arg === "--provider") {
      const value = nextValue(args, index, arg);
      if (value !== "openai-codex" && value !== "openrouter") throw new Error(`Unknown provider: ${value}`);
      provider = value;
      index += 1;
    } else if (arg === "--format") {
      const value = nextValue(args, index, arg);
      if (value !== "tree" && value !== "assembled" && value !== "json") throw new Error(`Unknown format: ${value}`);
      format = value;
      index += 1;
    } else if (arg === "--guild") {
      guildId = nextValue(args, index, arg);
      index += 1;
    } else if (arg === "--list") {
      list = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: bun run prompt:inspect -- [options]",
        "",
        "  --profile <id>       Active profile (default: PROFILE or 2b)",
        "  --surface <id>       Prompt scenario (default: discord)",
        "  --provider <id>      openai-codex or openrouter",
        "  --guild <id>         Apply one guild prompt-transport override",
        "  --format <format>    tree, assembled, or json",
        "  --list               List scenarios",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    profile,
    scenario,
    provider,
    format,
    ...(guildId !== undefined ? { guildId } : {}),
    list,
  };
}

function printScenarioList(): void {
  for (const scenario of promptScenarioSummaries()) {
    console.log(`${scenario.id.padEnd(48)} ${scenario.family.padEnd(11)} ${scenario.label}`);
  }
}

function metadata(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => part !== undefined && part !== "").join(" · ");
}

function printTree(inspection: PromptInspection): void {
  console.log(`${inspection.scenario.label} [${inspection.scenario.id}]`);
  console.log(metadata([
    `profile ${inspection.profile}`,
    inspection.provider,
    inspection.transportMode,
    `${inspection.totals.selectedDocuments} documents`,
    `${inspection.totals.selectedChars} chars`,
    `~${inspection.totals.estimatedTokens} tokens`,
  ]));
  console.log("");

  for (const document of inspection.documents) {
    console.log(`${String(document.order).padStart(2, "0")} ${document.phase.padEnd(8)} ${document.groupId}`);
    console.log(`   ${document.source}`);
    console.log(`   ${metadata([
      document.status,
      document.layer,
      document.role,
      document.target,
      document.cacheGroup !== undefined ? `cache ${document.cacheGroup}` : undefined,
      `${document.chars} chars`,
      `~${document.estimatedTokens} tokens`,
      document.sha256.slice(0, 12),
    ])}`);
    if (document.overriddenSources.length > 0) {
      console.log(`   overrides ${document.overriddenSources.join(", ")}`);
    }
    console.log(`   ${document.reason}`);
  }

  console.log("");
  console.log("Dynamic runtime sections");
  for (const section of inspection.dynamicSections) console.log(`- ${section}`);

  const conditional = inspection.catalog.filter((entry) => entry.status === "conditional");
  const unselected = inspection.catalog.filter((entry) => entry.status === "unselected");
  console.log("");
  console.log(`Catalog: ${inspection.catalog.length} effective documents; ${conditional.length} conditional; ${unselected.length} unselected; ${inspection.totals.overriddenDocuments} overridden.`);
  console.log("Use --format json for every source, full text, override chain, and assembled block.");
}

function printAssembled(inspection: PromptInspection): void {
  if (inspection.assembled.instructions !== "") {
    console.log("===== CODEX INSTRUCTIONS =====");
    console.log(inspection.assembled.instructions);
    console.log("");
  }
  for (const [index, item] of inspection.assembled.input.entries()) {
    console.log(`===== INPUT ${index + 1}: ${item.role} · ${item.phase}${item.cacheGroup !== undefined ? ` · cache ${item.cacheGroup}` : ""} =====`);
    console.log(item.text);
    console.log("");
  }
  console.log("===== DYNAMIC SECTIONS NOT RENDERED =====");
  for (const section of inspection.dynamicSections) console.log(`- ${section}`);
}

const options = parseArgs(process.argv.slice(2));
if (options.list) {
  printScenarioList();
  process.exit(0);
}

const root = process.cwd();
const profilesDir = join(root, "profiles");
const configPath = join(profilesDir, options.profile, "config.yaml");
const env = {
  ...process.env,
  PROFILE: options.profile,
  DISCORD_TOKEN: process.env.DISCORD_TOKEN ?? "prompt-inspector",
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "prompt-inspector",
};
const globalConfig = loadGlobalConfig(env, configPath);
const guildConfigs = loadGuildConfigs(join(profilesDir, options.profile, "guilds"), globalConfig);
const guildConfig = options.guildId !== undefined
  ? guildConfigs.get(options.guildId)
  : undefined;
if (options.guildId !== undefined && guildConfig === undefined) {
  throw new Error(`Guild config not found for ${options.guildId}`);
}
const transport = guildConfig?.promptTransport
  ?? resolveGuildConfig(globalConfig, { guildId: "prompt-inspector", slug: "prompt-inspector" }).promptTransport;
const bundle = loadInstructionBundle(profilesDir, options.profile, quietLogger());
const inspection = inspectPromptScenario({
  bundle,
  profile: options.profile,
  scenario: options.scenario,
  provider: options.provider,
  transport,
});

if (options.format === "json") {
  console.log(JSON.stringify(inspection, null, 2));
} else if (options.format === "assembled") {
  printAssembled(inspection);
} else {
  printTree(inspection);
}
