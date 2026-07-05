import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import type { Client } from "discord.js";
import type { GlobalConfig, GuildConfig } from "../config/types";
import type { Database } from "../db/database";
import { createLogger } from "../logger";
import type { SchedulerEngine } from "../scheduler/engine";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { createSessionStore } from "../vpn/session";
import { registerInteractionRuntime } from "./interaction-runtime";

function waitTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("registerInteractionRuntime", () => {
  test("reads the latest global config for each VPN interaction", async () => {
    const events = new EventEmitter();
    const client = events as unknown as Client;
    let globalConfig = { uiLang: "en" } as unknown as GlobalConfig;
    const replies: string[] = [];

    registerInteractionRuntime({
      client,
      db: {} as unknown as Database,
      qdrant: {} as unknown as QdrantClient,
      scheduler: {} as unknown as SchedulerEngine,
      getGlobalConfig: () => globalConfig,
      getGuildConfig: () => ({ adminUserIds: [] }) as unknown as GuildConfig,
      vpnClient: null,
      vpnSessionStore: createSessionStore(),
      vpnEnabled: false,
      startTime: 0,
      log: createLogger({ level: "error" }),
    });

    const makeInteraction = (): unknown => ({
      isButton: () => false,
      isStringSelectMenu: () => false,
      isChatInputCommand: () => true,
      commandName: "vpn",
      guildId: "guild",
      replied: false,
      deferred: false,
      user: { id: "user", username: "user" },
      reply: (payload: { content: string }) => {
        replies.push(payload.content);
        return Promise.resolve();
      },
    });

    events.emit("interactionCreate", makeInteraction());
    await waitTick();
    globalConfig = { uiLang: "ru" } as unknown as GlobalConfig;
    events.emit("interactionCreate", makeInteraction());
    await waitTick();

    expect(replies).toEqual([
      "VPN is disabled on this server.",
      "VPN отключен на этом сервере.",
    ]);
  });
});
