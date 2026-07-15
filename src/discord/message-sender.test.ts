import { describe, expect, test } from "bun:test";
import { MessageFlags } from "discord.js";
import { buildComponentsV2CardPayload } from "./message-sender";

describe("buildComponentsV2CardPayload", () => {
  test("builds a non-interactive Discord Components V2 card", () => {
    const payload = buildComponentsV2CardPayload(
      "## 🎲 Initiative\n### Result: 20",
      { kind: "components_v2_card", accentColor: 0x8f73ff },
      "nonce-1",
    );

    expect(payload.content).toBeUndefined();
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload.nonce).toBe("nonce-1");
    expect(payload.enforceNonce).toBe(true);
    expect(payload.components?.[0]?.toJSON()).toEqual({
      type: 17,
      accent_color: 0x8f73ff,
      components: [{ type: 10, content: "## 🎲 Initiative\n### Result: 20" }],
    });
  });
});
