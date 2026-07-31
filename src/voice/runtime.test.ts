import { afterEach, describe, expect, jest, setSystemTime, test } from "bun:test";
import type { Client, VoiceBasedChannel } from "discord.js";
import type { GuildConfig, VoiceConfig } from "../config/types.ts";
import { createDatabase } from "../db/database.ts";
import type { Logger } from "../logger.ts";
import { VoiceRepository } from "./repository.ts";
import { VoiceRuntime, type VoiceTurnRequest } from "./runtime.ts";

afterEach(() => {
  jest.useRealTimers();
  setSystemTime();
});

async function advanceTimersByTime(ms: number): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  jest.advanceTimersByTime(ms);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

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
      speakerCapture: { transcriber: typeof transcriber };
    };
    internals.active = {
      id: session.id,
      channel,
      config: {},
      voiceConfig: {
        enabled: true,
        recentSessionContextMs: 0,
        stt: {
          model: "scribe_v2_realtime",
          monthlyAudioLimitSeconds: 1,
          estimatedPricePerAudioHourUsd: 0.39,
        },
      } as VoiceConfig,
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
      elevenLabsAudioMs: 0,
      sessionElevenLabsAudioMs: 0,
      scribePartials: new Map(),
      attentionUntil: 0,
      lastTriggerReason: "none",
      speaking: new Set(),
      speakingSince: new Map(),
      subscriptions: new Set(),
    };
    internals.speakerCapture.transcriber = transcriber;

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
  test("uses incremental segment count and minimum interval instead of row-id modulo", () => {
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
      maintenance: {
        summary: { everySegments: 2, minIntervalMs: 1 },
        extraction: { everySegments: 10, minIntervalMs: 60_000 },
      },
    } as unknown as VoiceConfig;
    const internals = runtime as unknown as {
      active: { id: string; voiceConfig: VoiceConfig };
      maybeRunMaintenance: () => void;
    };
    internals.active = { id: session.id, voiceConfig };
    setSystemTime(Date.now() + 2);
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
    repository.setCheckpoint(session.id, "summary", latest.id);
    internals.maybeRunMaintenance();
    expect(maintenanceCalls).toBe(1);
    db.close();
  });
});

describe("VoiceRuntime response opportunities", () => {
  test("waits for the attention owner but bounds delay from another speaker", async () => {
    jest.useFakeTimers({ now: Date.now() });
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
      stt: {
        model: "scribe_v2_realtime",
        monthlyAudioLimitSeconds: 1,
        estimatedPricePerAudioHourUsd: 0.39,
      },
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
      config: {},
      voiceConfig,
      connection: {},
      player: {},
      transcriber: {},
      sttController: new AbortController(),
      transcriptionQueue: Promise.resolve(),
      pendingTranscriptions: 0,
      elevenLabsAudioMs: 0,
      sessionElevenLabsAudioMs: 0,
      scribePartials: new Map(),
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
    await advanceTimersByTime(15);
    expect(turns).toHaveLength(0);

    active.speaking = new Set();
    active.speakingSince = new Map();
    internals.scheduleOpportunity(active);
    await advanceTimersByTime(15);
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
    await advanceTimersByTime(10);
    expect(turns).toHaveLength(1);
    await advanceTimersByTime(30);
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
    await advanceTimersByTime(15);
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
    await advanceTimersByTime(15);
    expect(turns).toHaveLength(4);
    expect(turns[3]?.opportunity.owner?.username).toBe("bob");

    internals.active = undefined;
    db.close();
  });
});
