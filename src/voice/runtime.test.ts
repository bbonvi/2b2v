import { describe, expect, test } from "bun:test";
import type { Client, VoiceBasedChannel } from "discord.js";
import type { GuildConfig, VoiceConfig } from "../config/types.ts";
import { createDatabase } from "../db/database.ts";
import type { Logger } from "../logger.ts";
import { VoiceRepository } from "./repository.ts";
import { VoiceRuntime } from "./runtime.ts";

describe("VoiceRuntime shutdown", () => {
  test("ends the session without starting final maintenance", async () => {
    const db = createDatabase(":memory:");
    const repository = new VoiceRepository(db);
    const session = repository.createSession("guild", "voice");
    repository.updateSession(session.id, { state: "active" });
    let maintenanceCalls = 0;
    let connectionDestroyed = false;
    let playerStopped = false;
    let transcriberStopped = false;
    const log: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      logTokenUsage: () => {},
      child: () => log,
    };
    const client = {
      on: () => {},
      guilds: { cache: new Map() },
    } as unknown as Client;
    const runtime = new VoiceRuntime({
      client,
      repository,
      getGuildConfig: () => ({}) as GuildConfig,
      log,
      onTurn: () => Promise.resolve(),
      sendMessage: () => Promise.resolve({ sentMessageId: "message" }),
      onMaintenance: () => {
        maintenanceCalls += 1;
        return new Promise<void>(() => {});
      },
    });
    const channel = {
      id: "voice",
      name: "Voice",
      guild: { id: "guild", name: "Guild" },
      members: new Map(),
    } as unknown as VoiceBasedChannel;
    const transcriber = {
      shutdown: () => {
        transcriberStopped = true;
      },
    };
    const internals = runtime as unknown as {
      active: unknown;
      transcriber: typeof transcriber;
    };
    internals.active = {
      id: session.id,
      channel,
      config: {} as GuildConfig,
      voiceConfig: { enabled: true, recentSessionContextMs: 0 } as VoiceConfig,
      connection: {
        destroy: () => {
          connectionDestroyed = true;
        },
      },
      player: {
        stop: () => {
          playerStopped = true;
        },
      },
      transcriber,
      sttController: new AbortController(),
      transcriptionQueue: Promise.resolve(),
      pendingTranscriptions: 0,
      attentionUntil: 0,
      lastTriggerReason: "none",
      speaking: new Set(),
      subscriptions: new Set(),
    };
    internals.transcriber = transcriber;

    await runtime.shutdown();

    expect(repository.getSession(session.id)?.state).toBe("ended");
    expect(maintenanceCalls).toBe(0);
    expect(connectionDestroyed).toBe(true);
    expect(playerStopped).toBe(true);
    expect(transcriberStopped).toBe(true);
    db.close();
  });
});
