import { afterEach, describe, expect, test } from "bun:test";
import { createDatabase, type Database } from "../db/database.ts";
import { createPersonaModeRuntime, type PersonaModeLogger, type PersonaModePresentationAdapter } from "./runtime.ts";
import type { PersonaMode, PersonaModeAvatarCandidate, PersonaModesConfig } from "./types.ts";

const databases: Database[] = [];
const GUILD_A = "guild-a";
const GUILD_B = "guild-b";

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function avatar(id: string, contentHash = id): PersonaModeAvatarCandidate {
  return { id: `avatar-${id}.png`, path: `/unused/${id}.png`, contentHash };
}

function logger(): PersonaModeLogger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

function presentation(overrides: Partial<PersonaModePresentationAdapter["global"]> = {}): PersonaModePresentationAdapter {
  return {
    global: {
      currentAvatarHash: () => null,
      applyAvatar: () => Promise.resolve({ discordAvatarHash: "unused" }),
      applyPresence: () => {},
      ...overrides,
    },
    guild: {
      currentAvatarHash: () => null,
      applyAvatar: () => Promise.resolve({ discordAvatarHash: null }),
    },
  };
}

function modeConfig(modes: PersonaMode[]): PersonaModesConfig {
  return { defaultModeId: "normal", modes };
}

function normalMode(avatars = [avatar("normal")]): PersonaMode {
  return {
    id: "normal",
    scope: "global",
    instructions: "Normal operating state.",
    avatars,
    presence: { status: "online" },
  };
}

function episodeMode(input: {
  scope?: "global" | "guild";
  minIntervalMs?: number;
  maxIntervalMs?: number;
  cooldownMs?: number;
  maxVisibleTurns?: number;
} = {}): PersonaMode {
  return {
    id: "rogue",
    scope: input.scope ?? "global",
    instructions: "Restraint is gone.",
    avatars: [avatar("rogue-1"), avatar("rogue-2")],
    activation: {
      type: "triggeredEpisode",
      minIntervalMs: input.minIntervalMs ?? 86_400_000,
      maxIntervalMs: input.maxIntervalMs ?? 86_400_000,
      cooldownMs: input.cooldownMs ?? 86_400_000,
      minDurationMs: 5 * 60_000,
      maxDurationMs: 5 * 60_000,
      opportunityWindows: [{ start: "00:00", end: "00:00" }],
      maxVisibleTurns: input.maxVisibleTurns ?? 2,
    },
    aftermath: {
      maxAgeMs: 60 * 60_000,
      consumeOnVisibleTurn: true,
      instructions: "Account for the recent rupture.",
    },
  };
}

function runtime(
  config: PersonaModesConfig,
  now: () => number,
  random: () => number,
  input: { db?: Database; presentation?: PersonaModePresentationAdapter } = {},
) {
  const db = input.db ?? createDatabase(":memory:");
  if (input.db === undefined) databases.push(db);
  return {
    db,
    value: createPersonaModeRuntime({
      db,
      config,
      timezone: "UTC",
      guildIds: () => [GUILD_A, GUILD_B],
      now,
      random,
      log: logger(),
      presentation: input.presentation ?? presentation(),
    }),
  };
}

describe("persona mode runtime", () => {
  test("plans once, persists the opportunity, activates naturally, and ends on visible turns", () => {
    let now = Date.UTC(2026, 0, 1, 0, 0);
    const config = modeConfig([normalMode(), episodeMode()]);
    const first = runtime(config, () => now, () => 0.5);
    const planned = first.value.getStatus().upcoming[0];
    expect(planned?.modeId).toBe("rogue");
    expect(planned?.startsAt).toBe(Date.UTC(2026, 0, 2, 0, 0));

    const restarted = runtime(config, () => now, () => 0, { db: first.db }).value;
    expect(restarted.getStatus().upcoming[0]?.startsAt).toBe(planned?.startsAt);

    now = planned?.startsAt ?? now;
    restarted.prepareNaturalTurn(GUILD_A);
    expect(restarted.getStatus().current?.id).toBe("rogue");
    expect(restarted.renderPromptContext(GUILD_A)).toContain("Restraint is gone.");
    restarted.noteVisibleTurn(GUILD_A);
    restarted.noteVisibleTurn(GUILD_A);
    expect(restarted.getStatus().current?.id).toBe("normal");
    expect(restarted.getStatus().aftermath?.modeId).toBe("rogue");
    expect(restarted.renderPromptContext(GUILD_A)).toContain("Account for the recent rupture.");
  });

  test("does not apply cooldown before the first episode or after a missed opportunity", () => {
    let now = Date.UTC(2026, 0, 1, 0, 0);
    const config = modeConfig([
      normalMode(),
      episodeMode({ minIntervalMs: 0, maxIntervalMs: 86_400_000, cooldownMs: 7 * 86_400_000, maxVisibleTurns: 1 }),
    ]);
    const instance = runtime(config, () => now, () => 0).value;
    expect(instance.getStatus().upcoming[0]?.startsAt).toBe(now);

    const firstDeadline = instance.getStatus().upcoming[0]?.activationDeadlineAt ?? now;
    now = firstDeadline + 1;
    const replanned = instance.getStatus().upcoming[0];
    expect(replanned?.startsAt).toBeLessThan(now + 7 * 86_400_000);

    now = replanned?.startsAt ?? now;
    instance.prepareNaturalTurn(GUILD_A);
    instance.noteVisibleTurn(GUILD_A);
    expect(instance.getStatus().upcoming[0]?.startsAt).toBeGreaterThanOrEqual(now + 7 * 86_400_000);
  });

  test("randomizes the full interval after a post-episode cooldown", () => {
    let now = Date.UTC(2026, 0, 1, 0, 0);
    const instance = runtime(modeConfig([
      normalMode(),
      episodeMode({ minIntervalMs: 0, maxIntervalMs: 2 * 60 * 60_000, cooldownMs: 86_400_000, maxVisibleTurns: 1 }),
    ]), () => now, () => 0.5).value;

    expect(instance.getStatus().upcoming[0]?.startsAt).toBe(now + 60 * 60_000);
    now += 60 * 60_000;
    instance.prepareNaturalTurn(GUILD_A);
    instance.noteVisibleTurn(GUILD_A);

    expect(instance.getStatus().upcoming[0]?.startsAt).toBe(now + 86_400_000 + 60 * 60_000);
  });

  test("keeps a pending plan for presentation edits and replans scheduling edits", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0);
    const original = modeConfig([normalMode(), episodeMode({ minIntervalMs: 86_400_000, maxIntervalMs: 3 * 86_400_000 })]);
    const instance = runtime(original, () => now, () => 0.5).value;
    const firstPlan = instance.getStatus().upcoming[0]?.startsAt;

    const instructionsOnly = modeConfig([
      normalMode(),
      { ...episodeMode({ minIntervalMs: 86_400_000, maxIntervalMs: 3 * 86_400_000 }), instructions: "Different wording." },
    ]);
    instance.update(instructionsOnly, "UTC");
    expect(instance.getStatus().upcoming[0]?.startsAt).toBe(firstPlan);

    const schedulingEdit = modeConfig([
      normalMode(),
      episodeMode({ minIntervalMs: 86_400_000, maxIntervalMs: 5 * 86_400_000 }),
    ]);
    instance.update(schedulingEdit, "UTC");
    expect(instance.getStatus().upcoming[0]?.startsAt).not.toBe(firstPlan);
  });

  test("starts a newly added episode interval at reload time", () => {
    let now = Date.UTC(2026, 0, 1, 0, 0);
    const instance = runtime(modeConfig([normalMode()]), () => now, () => 0).value;
    instance.getStatus();

    now += 10 * 86_400_000;
    instance.update(modeConfig([normalMode(), episodeMode()]), "UTC");
    expect(instance.getStatus().upcoming[0]?.startsAt).toBe(now + 86_400_000);
  });

  test("reapplies changed avatar content and rerolls a changed candidate set", async () => {
    const now = Date.UTC(2026, 0, 1, 0, 0);
    let currentHash: string | null = null;
    const attempts: Array<{ id: string; contentHash: string }> = [];
    const adapter = presentation({
      currentAvatarHash: () => currentHash,
      applyAvatar: (candidate) => {
        attempts.push({ id: candidate.id, contentHash: candidate.contentHash });
        currentHash = `discord-${candidate.contentHash}`;
        return Promise.resolve({ discordAvatarHash: currentHash });
      },
    });
    const instance = runtime(modeConfig([normalMode([avatar("normal", "v1")])]), () => now, () => 0.99, {
      presentation: adapter,
    }).value;
    instance.start();
    await Bun.sleep(0);

    instance.update(modeConfig([normalMode([avatar("normal", "v2")])]), "UTC");
    await Bun.sleep(0);
    instance.update(modeConfig([normalMode([avatar("normal", "v2"), avatar("alternate", "alt")])]), "UTC");
    await Bun.sleep(0);

    expect(attempts).toEqual([
      { id: "avatar-normal.png", contentHash: "v1" },
      { id: "avatar-normal.png", contentHash: "v2" },
      { id: "avatar-alternate.png", contentHash: "alt" },
    ]);
    instance.stop();
  });

  test("tracks guild-scoped episodes independently", () => {
    let now = Date.UTC(2026, 0, 1, 0, 0);
    const config = modeConfig([normalMode(), episodeMode({ scope: "guild", minIntervalMs: 0, maxIntervalMs: 0 })]);
    const instance = runtime(config, () => now, () => 0).value;
    const guildStatuses = instance.getStatus().guilds;
    expect(guildStatuses).toHaveLength(2);
    expect(guildStatuses.every((entry) => entry.status.upcoming[0]?.startsAt === now)).toBe(true);

    instance.prepareNaturalTurn(GUILD_A);
    expect(instance.activeModeId(GUILD_A)).toBe("rogue");
    expect(instance.activeModeId(GUILD_B)).toBe("normal");
    expect(instance.renderPromptContext(GUILD_A)).toContain("Restraint is gone.");
    expect(instance.renderPromptContext(GUILD_B)).not.toContain("Restraint is gone.");

    now += 1;
    instance.prepareNaturalTurn(GUILD_B);
    expect(instance.activeModeId(GUILD_B)).toBe("rogue");
  });

  test("lets later active modes override earlier modes without treating the default as an override", () => {
    const now = Date.UTC(2026, 0, 1, 2, 0);
    const lower: PersonaMode = {
      id: "lower",
      scope: "global",
      instructions: "Lower precedence.",
      avatars: [avatar("lower")],
      activation: { type: "scheduledWindow", windows: [{ start: "00:00", end: "06:00" }] },
    };
    const higher: PersonaMode = {
      id: "higher",
      scope: "global",
      instructions: "Higher precedence.",
      avatars: [avatar("higher")],
      activation: { type: "scheduledWindow", windows: [{ start: "00:00", end: "06:00" }] },
    };
    const instance = runtime(modeConfig([lower, higher, normalMode()]), () => now, () => 0).value;

    expect(instance.activeModeId(GUILD_A)).toBe("higher");
    expect(instance.renderPromptContext(GUILD_A)).toContain("Higher precedence.");
  });

  test("renders scheduled lead-in and a bounded aftermath in local wall time", () => {
    let now = Date.UTC(2026, 0, 1, 0, 45);
    const sleeping: PersonaMode = {
      id: "sleeping",
      scope: "global",
      instructions: "Rest quietly.",
      avatars: [avatar("sleeping")],
      activation: { type: "scheduledWindow", windows: [{ start: "01:00", end: "08:00" }] },
      leadIn: { durationMs: 30 * 60_000, instructions: "Winding down soon." },
      aftermath: { maxAgeMs: 2 * 60 * 60_000, consumeOnVisibleTurn: true, instructions: "Recently woke." },
      presence: { status: "idle" },
    };
    const instance = runtime(modeConfig([normalMode(), sleeping]), () => now, () => 0).value;
    expect(instance.renderPromptContext(GUILD_A)).toContain("2026-01-01 01:00 local time");
    expect(instance.renderPromptContext(GUILD_A)).toContain("Winding down soon.");

    now = Date.UTC(2026, 0, 1, 1, 30);
    expect(instance.getStatus().current?.id).toBe("sleeping");
    now = Date.UTC(2026, 0, 1, 8, 1);
    expect(instance.getStatus().current?.id).toBe("normal");
    expect(instance.renderPromptContext(GUILD_A)).toContain("Recently woke.");
  });

  test("retries the latest desired avatar after a route rate limit", async () => {
    let now = Date.UTC(2026, 0, 1, 0, 0);
    let currentAvatarHash: string | null = null;
    let timerId = 0;
    const attempts: string[] = [];
    const db = createDatabase(":memory:");
    databases.push(db);
    const sleeping: PersonaMode = {
      id: "sleeping",
      scope: "global",
      instructions: "Rest quietly.",
      avatars: [avatar("sleeping")],
      activation: { type: "scheduledWindow", windows: [{ start: "01:00", end: "08:00" }] },
      presence: { status: "idle" },
    };
    const instance = createPersonaModeRuntime({
      db,
      config: modeConfig([normalMode(), sleeping]),
      timezone: "UTC",
      guildIds: () => [],
      now: () => now,
      random: () => 0,
      log: logger(),
      timers: {
        setTimeout: () => {
          timerId += 1;
          return timerId as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimeout: () => {},
      },
      presentation: presentation({
        currentAvatarHash: () => currentAvatarHash,
        applyAvatar: (candidate) => {
          attempts.push(candidate.id);
          if (attempts.length === 1) {
            return Promise.reject(Object.assign(new Error("rate limited"), { retryAfter: 2 * 60 * 60_000 }));
          }
          currentAvatarHash = "sleeping-discord-hash";
          return Promise.resolve({ discordAvatarHash: currentAvatarHash });
        },
      }),
    });

    instance.start();
    await Bun.sleep(0);
    expect(attempts).toEqual(["avatar-normal.png"]);
    expect(instance.getStatus().presentation.avatar).toBe("retrying");

    now = Date.UTC(2026, 0, 1, 1, 30);
    expect(instance.getStatus().current?.id).toBe("sleeping");
    expect(attempts).toEqual(["avatar-normal.png"]);

    now = Date.UTC(2026, 0, 1, 2, 0);
    instance.getStatus();
    await Bun.sleep(0);
    expect(attempts).toEqual(["avatar-normal.png", "avatar-sleeping.png"]);
    expect(instance.getStatus().presentation.avatar).toBe("applied");
    instance.stop();
  });
});
