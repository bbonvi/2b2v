import { describe, expect, test } from "bun:test";
import type { Guild } from "discord.js";
import { DEFAULT_AMBIENT_INITIATIVE } from "../config/defaults.ts";
import type { AmbientInitiativeConfig } from "../config/types.ts";
import {
  ambientInitiativeMemoryFocusUserId,
  applyAmbientInitiativeResistance,
  calculateAmbientInitiativePressure,
  formatBotContacts,
  type AmbientInitiativeSignals,
} from "./initiative-runtime.ts";

function config(overrides: Partial<AmbientInitiativeConfig> = {}): AmbientInitiativeConfig {
  return {
    ...DEFAULT_AMBIENT_INITIATIVE,
    enabled: true,
    basePressure: 0.28,
    ...overrides,
  };
}

function signals(overrides: Partial<AmbientInitiativeSignals> = {}): AmbientInitiativeSignals {
  const now = Date.UTC(2026, 6, 20, 12, 0, 0);
  return {
    now,
    inActiveHours: true,
    quietMs: 10 * 60 * 1000,
    lastHumanAt: now - 10 * 60 * 1000,
    lastBotAt: null,
    recentHumanCount: 3,
    recentBotCount: 0,
    pendingAmbientCandidates: 0,
    activeImageJobs: 0,
    strongestThreadPressure: 0,
    applicableThreadCount: 0,
    applicableThreads: [],
    lastInitiativeAt: null,
    visibleUserIds: ["user-1"],
    ...overrides,
  };
}

function guildWithUsers(users: ReadonlyArray<{ id: string; username: string }>): Guild {
  const cache = new Map(users.map(({ id, username }) => [id, { user: { username } }]));
  return {
    members: { cache },
    client: { users: { cache: new Map() } },
  } as unknown as Guild;
}

describe("Ambient Initiative contact context", () => {
  test("uses the newest visible human as the autonomous memory focus", () => {
    expect(ambientInitiativeMemoryFocusUserId(signals({
      visibleUserIds: ["newest", "older"],
    }))).toBe("newest");
    expect(ambientInitiativeMemoryFocusUserId(signals({
      visibleUserIds: [],
    }))).toBeUndefined();
  });

  test("formats known bot contacts with usernames and IDs", () => {
    const guild = guildWithUsers([{ id: "1398275457857622128", username: "pod_042" }]);

    expect(formatBotContacts(guild, ["1398275457857622128"])).toBe(
      "@pod_042 (1398275457857622128)",
    );
  });

  test("falls back to the ID when a contact is not cached", () => {
    expect(formatBotContacts(guildWithUsers([]), ["1398275457857622128"])).toBe(
      "1398275457857622128",
    );
  });
});

describe("Ambient Initiative pressure", () => {
  test("lets nominal pressure probabilistically reach the evaluator without an inner thread", () => {
    expect(calculateAmbientInitiativePressure(config(), signals(), 0.27)).toMatchObject({
      rawValue: 0.28,
      value: 0.28,
      passed: true,
      adjustments: [],
    });
    expect(calculateAmbientInitiativePressure(config(), signals(), 0.29)).toMatchObject({
      value: 0.28,
      passed: false,
    });
  });

  test("continuously amplifies pressure from the strongest applicable thread", () => {
    const pressure = calculateAmbientInitiativePressure(
      config(),
      signals({ strongestThreadPressure: 0.75, applicableThreadCount: 2 }),
      0.8,
    );

    expect(pressure.value).toBeCloseTo(0.82);
    expect(pressure.passed).toBe(true);
  });

  test("ordinary resistance suppresses low pressure without erasing maximum pressure", () => {
    expect(applyAmbientInitiativeResistance(0.28, 0.2)).toBeLessThan(0.28);
    expect(applyAmbientInitiativeResistance(1, 0.2)).toBe(1);

    const now = signals().now;
    const pressure = calculateAmbientInitiativePressure(
      config(),
      signals({
        strongestThreadPressure: 1,
        inActiveHours: false,
        quietMs: null,
        lastHumanAt: null,
        lastBotAt: now - 1000,
        lastInitiativeAt: now - 1000,
      }),
      0.99,
    );

    expect(pressure.value).toBe(1);
    expect(pressure.passed).toBe(true);
    expect(pressure.adjustments).toEqual([
      "outside_active_hours",
      "no_recent_human_activity",
      "recent_actor_output",
      "recent_visible_initiative",
    ]);
  });
});
