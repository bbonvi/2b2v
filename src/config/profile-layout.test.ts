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
      expect(existsSync(join(PROFILES_DIR, profile, "instructions", "core", "00-system"))).toBe(true);
      expect(existsSync(join(PROFILES_DIR, profile, "instructions", "core", "10-persona"))).toBe(true);
      expect(existsSync(join(PROFILES_DIR, profile, "instructions", "core", "20-style"))).toBe(true);
      expect(existsSync(join(PROFILES_DIR, profile, "instructions", "core", "30-runtime"))).toBe(true);
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
      const sharedToolDescriptions = [
        "cancel_agent_job",
        "dismiss_agent_job",
        "fetch_url",
        "list_agent_jobs",
        "list_channel_messages",
        "list_inner_threads",
        "read_asset",
        "read_agent_job",
        "search_asset",
        "search_channel_messages",
        "search_memories",
        "search_tools",
        "send_agent_message",
        "spawn_agent",
        "update_current_scheduled_task",
      ];
      const profileToolDescriptions = profile === "2b"
        ? [
            "instruct_voice_channel",
            "join_voice_channel",
            "leave_voice_channel",
            "find_notebooks",
            "list_notebook_revisions",
            "manage_notebook",
            "patch_notebook",
            "read_notebook",
            "search_notebook",
          ]
        : [];
      expect(Object.keys(bundle.runtime.toolDescriptions).sort()).toEqual(
        [...sharedToolDescriptions, ...profileToolDescriptions].sort(),
      );

      const sharedParameterDescriptions = [
        "list_channel_messages/around_message_id",
        "list_channel_messages/channel_id",
        "search_channel_messages/scope",
        "update_current_event_watch/handoffNote",
        "update_current_scheduled_task/handoffNote",
      ];
      const profileParameterDescriptions = profile === "2b"
        ? ["instruct_voice_channel/instruction", "patch_notebook/patch"]
        : [];
      expect(Object.keys(bundle.runtime.toolParameterDescriptions).sort()).toEqual(
        [...sharedParameterDescriptions, ...profileParameterDescriptions].sort(),
      );
      for (const description of [
        ...Object.values(bundle.runtime.toolDescriptions),
        ...Object.values(bundle.runtime.toolParameterDescriptions),
      ]) {
        expect(description).not.toContain("{{");
      }

      for (const tool of ["codex_generate_image", "create_event_watch", "roll_dice", "schedule_task", "start_thread", "close_thread"]) {
        expect(bundle.runtime.toolDescriptions[tool]).toBeUndefined();
        expect(Object.keys(bundle.runtime.toolParameterDescriptions).some((key) => key.startsWith(`${tool}/`))).toBe(false);
      }
      expect(Object.keys(bundle.runtime.contextTemplates).length).toBeGreaterThan(0);
      expect(bundle.runtime.contextTemplates["private-commitments"]).toBeDefined();
      expect(bundle.runtime.contextTemplates["upcoming-schedules"]).toBeUndefined();
      expect(bundle.runtime.skills.byId.image_generation).toBeDefined();
      expect(bundle.runtime.skills.byId.dice_roleplay).toBeDefined();
      expect(bundle.runtime.skills.byId.discord_threads).toBeDefined();
      expect(bundle.runtime.skills.byId.event_watches).toBeDefined();
      expect(bundle.runtime.skills.byId.scheduling).toBeDefined();
      expect(bundle.runtime.skills.requiredByTool.roll_dice).toBe("dice_roleplay");
      expect(bundle.runtime.skills.requiredByTool.start_thread).toBe("discord_threads");
      expect(bundle.runtime.skills.requiredByTool.close_thread).toBe("discord_threads");
      expect(bundle.runtime.skills.requiredByTool.create_event_watch).toBe("event_watches");
      expect(bundle.runtime.skills.requiredByTool.list_event_watches).toBe("event_watches");
      expect(bundle.runtime.skills.requiredByTool.delete_event_watch).toBe("event_watches");
      expect(bundle.runtime.skills.requiredByTool.schedule_task).toBe("scheduling");
      expect(bundle.runtime.skills.requiredByTool.list_scheduled_tasks).toBe("scheduling");
      expect(bundle.runtime.skills.requiredByTool.delete_scheduled_task).toBe("scheduling");
      if (profile === "2b") {
        for (const tool of [
          "find_notebooks",
          "search_notebook",
          "patch_notebook",
          "list_notebook_revisions",
          "manage_notebook",
        ]) {
          expect(bundle.runtime.skills.requiredByTool[tool]).toBe("notebooks");
        }
        expect(bundle.runtime.skills.requiredByTool.read_notebook).toBeUndefined();
      }
      expect(bundle.runtime.skills.requiredByTool.codex_generate_image).toBe("image_generation");
      for (const tool of ["cancel_agent_job", "list_agent_jobs", "read_agent_job", "dismiss_agent_job", "spawn_agent", "send_agent_message"]) {
        expect(bundle.runtime.skills.requiredByTool[tool]).toBeUndefined();
      }
      if (profile === "2b") {
        expect(bundle.runtime.skills.byId.workspace?.requiredForTools).toEqual([
          "workspace_exec",
          "export_asset_to_workspace",
          "stage_workspace_file",
        ]);
      }
      if (profile === "2b") {
        expect(bundle.runtime.privateLife?.length).toBeGreaterThan(500);
      } else {
        expect(bundle.runtime.privateLife ?? "").toBe("");
      }
    }
  });

  test("shares commitment skills while preserving profile image overrides", () => {
    const twoB = loadInstructionBundle(PROFILES_DIR, "2b", makeLogger());
    const delamain = loadInstructionBundle(PROFILES_DIR, "delamain", makeLogger());

    expect(twoB.runtime.skills.byId.scheduling?.content).toBe(delamain.runtime.skills.byId.scheduling?.content);
    expect(twoB.runtime.skills.byId.event_watches?.content).toBe(delamain.runtime.skills.byId.event_watches?.content);
    expect(twoB.runtime.skills.byId.discord_threads?.content).toBe(delamain.runtime.skills.byId.discord_threads?.content);
    expect(twoB.runtime.skills.byId.image_generation?.content)
      .not.toBe(delamain.runtime.skills.byId.image_generation?.content);
  });

  test("loads shared bot conversation policy for every profile", () => {
    const policyPath = join(PROFILES_DIR, "shared", "instructions", "core", "30-runtime", "05-bot-conversations.md");
    const policy = readFileSync(policyPath, "utf-8").trim();

    for (const profile of ["2b", "delamain"]) {
      const bundle = loadInstructionBundle(PROFILES_DIR, profile, makeLogger());
      expect(bundle.runtime.reply).toContain(policy);
    }
  });

  test("derives profile selection from config paths", () => {
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
    expect(twoB.runtimeProfileId).toBe("2b");
    expect(delamain.runtimeProfileId).toBe("delamain");
  });
});
