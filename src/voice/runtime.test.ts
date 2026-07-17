import { describe, expect, test } from "bun:test";
import type { Client, VoiceBasedChannel } from "discord.js";
import type { GuildConfig, VoiceConfig } from "../config/types.ts";
import { createDatabase } from "../db/database.ts";
import type { Logger } from "../logger.ts";
import { VoiceRepository } from "./repository.ts";
import { VoiceRuntime, type VoiceTurnRequest } from "./runtime.ts";

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
      speakingSince: new Map(),
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

describe("VoiceRuntime maintenance cadence", () => {
  test("uses incremental segment count and minimum interval instead of row-id modulo", async () => {
    const db = createDatabase(":memory:");
    const repository = new VoiceRepository(db);
    const session = repository.createSession("guild", "voice");
    let maintenanceCalls = 0;
    const log: Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      logTokenUsage: () => {},
      child: () => log,
    };
    const client = { on: () => {} } as unknown as Client;
    const runtime = new VoiceRuntime({
      client,
      repository,
      getGuildConfig: () => ({}) as GuildConfig,
      log,
      onTurn: () => Promise.resolve(),
      sendMessage: () => Promise.resolve({ sentMessageId: "message" }),
      onMaintenance: () => {
        maintenanceCalls += 1;
        return Promise.resolve();
      },
    });
    const voiceConfig = {
      maintenanceEverySegments: 2,
      maintenanceMinIntervalMs: 1,
    } as VoiceConfig;
    const internals = runtime as unknown as {
      active: { id: string; voiceConfig: VoiceConfig };
      maybeRunMaintenance: () => void;
    };
    internals.active = { id: session.id, voiceConfig };
    await Bun.sleep(2);
    for (const [index, text] of ["one", "two"].entries()) {
      repository.addTranscript({
        sessionId: session.id,
        userId: "alice",
        username: "alice",
        startedAt: index + 1,
        endedAt: index + 1,
        rawText: text,
        normalizedText: text,
        language: "en",
        sttModel: "test",
        source: "stt",
        synthetic: false,
      });
    }

    internals.maybeRunMaintenance();
    expect(maintenanceCalls).toBe(1);
    const latest = repository.listTranscript(session.id).at(-1);
    if (latest === undefined) throw new Error("Expected transcript");
    repository.setCheckpoint(session.id, "memory", latest.id);
    internals.maybeRunMaintenance();
    expect(maintenanceCalls).toBe(1);
    db.close();
  });
});

describe("VoiceRuntime response opportunities", () => {
  test("waits for the attention owner but bounds delay from another speaker", async () => {
    const db = createDatabase(":memory:");
    const repository = new VoiceRepository(db);
    const session = repository.createSession("guild", "voice");
    repository.updateSession(session.id, { state: "active" });
    const turns: VoiceTurnRequest[] = [];
    let blockNextTurn = false;
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
      onTurn: (request) => {
        turns.push(request);
        if (blockNextTurn) {
          blockNextTurn = false;
          return new Promise<void>((resolve) => {
            request.abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        return Promise.resolve();
      },
      sendMessage: () => Promise.resolve({ sentMessageId: "message" }),
      onMaintenance: () => Promise.resolve(),
    });
    const alice = { id: "alice", user: { username: "alice", bot: false } };
    const bob = { id: "bob", user: { username: "bob", bot: false } };
    const channel = {
      id: "voice",
      name: "Voice",
      guild: { id: "guild", name: "Guild" },
      members: new Map([["alice", alice], ["bob", bob]]),
    } as unknown as VoiceBasedChannel;
    const voiceConfig = {
      enabled: true,
      recentSessionContextMs: 60_000,
      roomQuietMs: 5,
      otherSpeakerGraceMs: 25,
    } as VoiceConfig;
    const trigger = repository.addTranscript({
      sessionId: session.id,
      userId: "alice",
      username: "alice",
      startedAt: Date.now(),
      endedAt: Date.now(),
      rawText: "2B?",
      normalizedText: "2B?",
      language: "en",
      sttModel: "test",
      source: "test_injection",
      synthetic: true,
    });
    const active: Record<string, unknown> = {
      id: session.id,
      channel,
      config: {} as GuildConfig,
      voiceConfig,
      connection: {},
      player: {},
      transcriber: {},
      sttController: new AbortController(),
      transcriptionQueue: Promise.resolve(),
      pendingTranscriptions: 0,
      attentionUntil: Date.now() + 45_000,
      attentionOwner: { userId: "alice", username: "alice" },
      lastTriggerReason: "wake_word",
      speaking: new Set(["alice"]),
      speakingSince: new Map([["alice", Date.now()]]),
      subscriptions: new Set(),
      opportunity: {
        trigger,
        source: "wake_word",
        openedAt: Date.now(),
        owner: { userId: "alice", username: "alice" },
        recentInterrupters: [],
      },
    };
    const internals = runtime as unknown as {
      active: unknown;
      scheduleOpportunity: (value: unknown) => void;
      queueOpportunity: (value: unknown, opportunity: unknown, deferForTranscription: boolean) => void;
    };
    internals.active = active;

    internals.scheduleOpportunity(active);
    await Bun.sleep(15);
    expect(turns).toHaveLength(0);

    active.speaking = new Set();
    active.speakingSince = new Map();
    internals.scheduleOpportunity(active);
    await Bun.sleep(15);
    expect(turns).toHaveLength(1);

    const secondTrigger = repository.addTranscript({
      sessionId: session.id,
      userId: "alice",
      username: "alice",
      startedAt: Date.now(),
      endedAt: Date.now(),
      rawText: "Answer me.",
      normalizedText: "Answer me.",
      language: "en",
      sttModel: "test",
      source: "test_injection",
      synthetic: true,
    });
    active.speaking = new Set(["bob"]);
    active.speakingSince = new Map([["bob", Date.now()]]);
    active.opportunity = {
      trigger: secondTrigger,
      source: "lingering",
      openedAt: Date.now(),
      owner: { userId: "alice", username: "alice" },
      recentInterrupters: [{ userId: "bob", username: "bob", at: Date.now() }],
    };
    internals.scheduleOpportunity(active);
    await Bun.sleep(10);
    expect(turns).toHaveLength(1);
    await Bun.sleep(30);
    expect(turns).toHaveLength(2);
    expect(turns[1]?.opportunity.currentSpeakers[0]?.username).toBe("bob");

    active.speaking = new Set();
    active.speakingSince = new Map();
    const thirdTrigger = repository.addTranscript({
      sessionId: session.id,
      userId: "alice",
      username: "alice",
      startedAt: Date.now(),
      endedAt: Date.now(),
      rawText: "Old question.",
      normalizedText: "Old question.",
      language: "en",
      sttModel: "test",
      source: "test_injection",
      synthetic: true,
    });
    active.opportunity = {
      trigger: thirdTrigger,
      source: "lingering",
      openedAt: Date.now(),
      owner: { userId: "alice", username: "alice" },
      recentInterrupters: [],
    };
    blockNextTurn = true;
    internals.scheduleOpportunity(active);
    await Bun.sleep(15);
    expect(turns).toHaveLength(3);

    const retargetedTrigger = repository.addTranscript({
      sessionId: session.id,
      userId: "bob",
      username: "bob",
      startedAt: Date.now(),
      endedAt: Date.now(),
      rawText: "2B, new question.",
      normalizedText: "2B, new question.",
      language: "en",
      sttModel: "test",
      source: "test_injection",
      synthetic: true,
    });
    internals.queueOpportunity(active, {
      trigger: retargetedTrigger,
      source: "wake_word",
      openedAt: Date.now(),
      owner: { userId: "bob", username: "bob" },
      recentInterrupters: [],
    }, false);
    await Bun.sleep(15);
    expect(turns).toHaveLength(4);
    expect(turns[3]?.opportunity.owner?.username).toBe("bob");

    internals.active = undefined;
    db.close();
  });
});
