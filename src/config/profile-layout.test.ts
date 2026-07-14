import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { Logger } from "../logger.ts";
import { loadInstructionBundle } from "./instruction-bundle.ts";
import { loadGlobalConfig, loadMainConfig } from "./loader.ts";
import { requireProfileConfigPath } from "./profile.ts";

const ROOT_DIR = join(import.meta.dir, "../..");
const PROFILES_DIR = join(ROOT_DIR, "profiles");

function makeLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    logTokenUsage: () => {},
    child: () => makeLogger(),
  };
}

describe("repository profile layout", () => {
  test("keeps configuration and instructions under profiles", () => {
    expect(readdirSync(join(PROFILES_DIR, "shared")).sort()).toEqual(["instructions"]);

    for (const profile of ["2b", "delamain"]) {
      expect(existsSync(join(PROFILES_DIR, profile, "config.yaml"))).toBe(true);
      expect(existsSync(join(PROFILES_DIR, profile, "instructions", "system"))).toBe(true);
      expect(existsSync(join(PROFILES_DIR, profile, "instructions", "core"))).toBe(true);
    }
    expect(() => requireProfileConfigPath(PROFILES_DIR, "shared")).toThrow("config not found");
  });

  test("loads complete layered instruction bundles", () => {
    for (const profile of ["2b", "delamain"]) {
      const bundle = loadInstructionBundle(PROFILES_DIR, profile, makeLogger());
      expect(bundle.systemDocuments.length).toBeGreaterThan(0);
      expect(bundle.coreDocuments.length).toBeGreaterThan(0);
      expect(bundle.runtime.reply).not.toBe("");
      expect(bundle.runtime.finalActionInstruction).not.toBe("");
      expect(Object.keys(bundle.runtime.toolDescriptions).length).toBeGreaterThan(0);
      expect(Object.keys(bundle.runtime.toolParameterDescriptions).length).toBeGreaterThan(0);
      expect(Object.keys(bundle.runtime.contextTemplates).length).toBeGreaterThan(0);
      expect(bundle.runtime.skills.byId.image_generation).toBeDefined();
    }
  });

  test("loads shared bot conversation policy for every profile", () => {
    const policyPath = join(PROFILES_DIR, "shared", "instructions", "runtime", "reply", "05-bot-conversations.md");
    const policy = readFileSync(policyPath, "utf-8").trim();

    for (const profile of ["2b", "delamain"]) {
      const bundle = loadInstructionBundle(PROFILES_DIR, profile, makeLogger());
      expect(bundle.runtime.reply).toContain(policy);
    }
  });

  test("keeps profile selection out of YAML and preserves feature boundaries", () => {
    const env = {
      DISCORD_TOKEN: "test",
      OPENROUTER_API_KEY: "test",
      VPN_API_URL: "https://vpn.example.com",
      VPN_PEER: "vpn-peer",
    };
    const twoBPath = join(PROFILES_DIR, "2b", "config.yaml");
    const delamainPath = join(PROFILES_DIR, "delamain", "config.yaml");
    const twoB = loadGlobalConfig(env, twoBPath);
    const delamain = loadGlobalConfig(env, delamainPath);

    expect(loadMainConfig(twoBPath)).not.toHaveProperty("persona");
    expect(loadMainConfig(delamainPath)).not.toHaveProperty("persona");
    expect(twoB.defaultRelationships?.enabled).toBe(true);
    expect(twoB.vpn?.enabled).toBe(true);
    expect(delamain.defaultRelationships?.enabled).toBe(false);
    expect(delamain.defaultMemoryExtraction.ambient.enabled).toBe(false);
    expect(delamain.defaultAmbientAttention?.enabled).toBe(false);
    expect(delamain.defaultAmbientInitiative?.enabled).toBe(true);
    expect(delamain.defaultAmbientInitiative?.audience).toBe("bots");
    expect(delamain.defaultAmbientInitiative?.botTargetIds).toEqual(["1130796465049042954"]);
    expect(delamain.defaultAmbientInitiative?.botPressure).toBe(0.15);
    expect(delamain.vpn).toBeUndefined();
  });
});
