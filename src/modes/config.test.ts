import { describe, expect, test } from "bun:test";
import { join } from "path";
import { resolvePersonaModesConfig } from "./config.ts";

describe("persona mode config", () => {
  test("allows a presentation-only mode with no behavioral instructions", () => {
    const profileRoot = join(import.meta.dir, "../../profiles/2b");
    const config = resolvePersonaModesConfig({
      default: "normal",
      modes: [{ id: "normal" }],
    }, profileRoot);

    expect(config?.modes[0]?.instructions).toBe("");
    expect(config?.modes[0]?.avatars.length).toBeGreaterThan(0);
    expect(config?.modes[0]?.scope).toBe("global");
  });

  test("accepts zero episode intervals and a guild scope", () => {
    const profileRoot = join(import.meta.dir, "../../profiles/delamain");
    const config = resolvePersonaModesConfig({
      default: "normal",
      modes: [
        {
          id: "rogue",
          scope: "guild",
          activation: {
            type: "triggeredEpisode",
            minInterval: 0,
            maxInterval: "1d",
            cooldown: "7d",
            minDuration: "1m",
            maxDuration: "2m",
            opportunityWindows: [{ start: "00:00", end: "00:00" }],
            maxVisibleTurns: 1,
          },
        },
        { id: "normal" },
      ],
    }, profileRoot);

    expect(config?.modes[0]?.scope).toBe("guild");
    expect(config?.modes[0]?.activation).toMatchObject({ minIntervalMs: 0, cooldownMs: 604_800_000 });
  });

  test("rejects global presence on a guild-scoped mode", () => {
    const profileRoot = join(import.meta.dir, "../../profiles/delamain");
    expect(() => resolvePersonaModesConfig({
      default: "normal",
      modes: [
        { id: "rogue", scope: "guild", presence: { status: "dnd" } },
        { id: "normal" },
      ],
    }, profileRoot)).toThrow("Discord presence is global");
  });
});
