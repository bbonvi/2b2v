import { type Logger } from "../logger";
import { loadGlobalConfig, loadGuildConfigs, validateTrimConfig } from "../config/loader";
import type { GuildConfig } from "../config/types";
import { type createModelImageSupportStore } from "../llm/model-image-support";
import { resolveModelProfile } from "../llm/client";
import { loadInstructionBundle, type PromptBundle } from "../config/instruction-bundle";
import { requireProfileConfigPath } from "../config/profile";
import { type AsyncTaskTracker } from "../runtime/async-task-tracker";
import { join } from "path";
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from "fs";

export function createConfigReloadRuntime(input: {
    profile: string;
    profilesDir: string;
    profileDir: string;
    configPath: string;
    guildsDir: string;
    log: Logger;
    backgroundTasks: AsyncTaskTracker;
    modelImageSupport: ReturnType<typeof createModelImageSupportStore>;
    getGlobalConfig: () => ReturnType<typeof loadGlobalConfig>;
    setGlobalConfig: (config: ReturnType<typeof loadGlobalConfig>) => void;
    setPromptBundle: (bundle: PromptBundle) => void;
    guildConfigs: Map<string, GuildConfig>;
    isAcceptingEvents: () => boolean;
    updatePersonaModes: (config: ReturnType<typeof loadGlobalConfig>["personaModes"], timezone: string) => void;
    resetDispatchers: () => () => Promise<void>;
    clearAmbientState: () => void;
    restartAmbientLoops: () => void;
  }
) {
  const { profile, profilesDir, profileDir, configPath, guildsDir, log, backgroundTasks, modelImageSupport, getGlobalConfig, setGlobalConfig, setPromptBundle, guildConfigs, isAcceptingEvents, updatePersonaModes, resetDispatchers, clearAmbientState, restartAmbientLoops } = input;
const CONFIG_RELOAD_DEBOUNCE_MS = 500;
const CONFIG_RELOAD_POLL_MS = 5000;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
let configReloadPollTimer: ReturnType<typeof setInterval> | null = null;
const configWatchers: FSWatcher[] = [];
let lastConfigFingerprint = configReloadFingerprint();

function scheduleConfigReload(): void {
  if (!isAcceptingEvents()) return;
  if (reloadTimer !== null) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    void backgroundTasks.track(reloadConfigs());
  }, CONFIG_RELOAD_DEBOUNCE_MS);
}

function configReloadFingerprint(): string {
  const parts: string[] = [];
  const pending = [profileDir];
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined) continue;
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    parts.push(`${path}:${stat.mtimeMs}:${stat.size}`);
    if (!stat.isDirectory()) continue;
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (/\.(?:ya?ml|md|png|jpe?g|webp)$/i.test(entry.name)) pending.push(entryPath);
    }
  }
  return parts.sort().join("|");
}

async function reloadConfigs(): Promise<void> {
  try {
    requireProfileConfigPath(profilesDir, profile);
    const newGlobal = loadGlobalConfig(
      process.env,
      configPath,
    );
    validateTrimConfig(newGlobal.defaultTrim);

    // Reload guild configs — clear and rebuild
    const newGuilds = loadGuildConfigs(guildsDir, newGlobal);
    await modelImageSupport.refresh(newGlobal, newGuilds, "hot_reload");
    if (!isAcceptingEvents()) return;

    setGlobalConfig(newGlobal);
    setPromptBundle(loadInstructionBundle(profilesDir, profile, log));
    updatePersonaModes(newGlobal.personaModes, newGlobal.defaultTimezone);

    guildConfigs.clear();
    for (const [id, cfg] of newGuilds) {
      guildConfigs.set(id, cfg);
    }

    // Swap first so new events use the new config while previously accepted work drains intact.
    const drainDispatchers = resetDispatchers();
    clearAmbientState();
    restartAmbientLoops();
    await drainDispatchers();

    log.info("config hot-reloaded", {
      modelProfile: getGlobalConfig().defaultModelProfile,
      model: resolveModelProfile(getGlobalConfig(), getGlobalConfig().defaultModelProfile).model,
      guilds: guildConfigs.size,
    });
  } catch (err) {
    log.error("config hot-reload failed, keeping previous config", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

if (existsSync(profileDir)) {
  const watcher = watch(profileDir, { recursive: true }, (_event, _filename) => {
    lastConfigFingerprint = configReloadFingerprint();
    scheduleConfigReload();
  });

  // Prevent watcher from keeping the process alive during shutdown
  watcher.unref();
  configWatchers.push(watcher);
  log.info("profile hot-reload watcher started");

  configReloadPollTimer = setInterval(() => {
    const fingerprint = configReloadFingerprint();
    if (fingerprint === lastConfigFingerprint) return;
    lastConfigFingerprint = fingerprint;
    scheduleConfigReload();
  }, CONFIG_RELOAD_POLL_MS);
  configReloadPollTimer.unref();
  log.info("config hot-reload poller started", { intervalMs: CONFIG_RELOAD_POLL_MS });
}

const sharedInstructionsDir = join(profilesDir, "shared", "instructions");
if (existsSync(sharedInstructionsDir)) {
  const watcher = watch(sharedInstructionsDir, { recursive: true }, (_event, _filename) => {
    scheduleConfigReload();
  });

  watcher.unref();
  configWatchers.push(watcher);
  log.info("shared instructions hot-reload watcher started");
}

  return { reloadConfigs, close: () => { if (configReloadPollTimer !== null) clearInterval(configReloadPollTimer); if (reloadTimer !== null) clearTimeout(reloadTimer); for (const watcher of configWatchers) watcher.close(); } };
}
