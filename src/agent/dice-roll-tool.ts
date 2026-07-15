import { randomInt } from "node:crypto";
import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "../db/database";
import {
  createOrGetDiceRoll,
  getDiceRollByRequestKey,
  markDiceRollDelivered,
  type DiceRollMode,
  type DiceRollRow,
} from "../db/dice-roll-repository";

export const MAX_DICE_COUNT = 100;
export const MAX_DIE_SIDES = 1_000_000;
export const MAX_DICE_MODIFIER = 1_000_000;
export const MAX_DICE_TARGET = 1_000_000_000;
export const MAX_DICE_LABEL_LENGTH = 500;

const DiceRollParams = Type.Object({
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DICE_COUNT, default: 1 })),
  sides: Type.Optional(Type.Integer({ minimum: 2, maximum: MAX_DIE_SIDES, default: 20 })),
  modifier: Type.Optional(Type.Integer({ minimum: -MAX_DICE_MODIFIER, maximum: MAX_DICE_MODIFIER, default: 0 })),
  target: Type.Optional(Type.Integer({ minimum: -MAX_DICE_TARGET, maximum: MAX_DICE_TARGET })),
  mode: Type.Optional(Type.Union([
    Type.Literal("normal"),
    Type.Literal("advantage"),
    Type.Literal("disadvantage"),
  ], { default: "normal" })),
  label: Type.Optional(Type.String({ maxLength: MAX_DICE_LABEL_LENGTH })),
  actor: Type.Optional(Type.String({ maxLength: 100 })),
});

export type DiceRollInput = Static<typeof DiceRollParams>;

export interface DiceActor {
  userId: string;
  username: string;
}

export interface DiceRollDelivery {
  text: string;
  sourceMessageId: string;
  dedupeKey: string;
  signal?: AbortSignal;
}

export interface DiceRollToolDeps {
  db: Database;
  guildId: string;
  channelId: string;
  currentRequest: {
    requesterId: string;
    requesterUsername: string;
    sourceMessageId: string;
  };
  resolveActor: (reference: string) => Promise<DiceActor | null>;
  deliver: (input: DiceRollDelivery) => Promise<{ sentMessageId: string }>;
  randomInteger?: (minimum: number, maximumExclusive: number) => number;
}

interface NormalizedDiceRoll {
  count: number;
  sides: number;
  modifier: number;
  target?: number;
  mode: DiceRollMode;
  label?: string;
  actorReference?: string;
}

function normalizeDiceRollInput(params: DiceRollInput): NormalizedDiceRoll | { error: string } {
  const count = params.count ?? 1;
  const sides = params.sides ?? 20;
  const modifier = params.modifier ?? 0;
  const target = params.target;
  const mode = params.mode ?? "normal";
  const label = params.label?.trim();
  const actorReference = params.actor?.trim();

  if (!Number.isInteger(count) || count < 1 || count > MAX_DICE_COUNT) {
    return { error: `count must be an integer from 1 to ${MAX_DICE_COUNT}.` };
  }
  if (!Number.isInteger(sides) || sides < 2 || sides > MAX_DIE_SIDES) {
    return { error: `sides must be an integer from 2 to ${MAX_DIE_SIDES}.` };
  }
  if (!Number.isInteger(modifier) || Math.abs(modifier) > MAX_DICE_MODIFIER) {
    return { error: `modifier must be an integer from -${MAX_DICE_MODIFIER} to ${MAX_DICE_MODIFIER}.` };
  }
  if (target !== undefined && (!Number.isInteger(target) || Math.abs(target) > MAX_DICE_TARGET)) {
    return { error: `target must be an integer from -${MAX_DICE_TARGET} to ${MAX_DICE_TARGET}.` };
  }
  if (mode !== "normal" && count !== 1) {
    return { error: `${mode} requires count=1.` };
  }
  if (label !== undefined && label.length > MAX_DICE_LABEL_LENGTH) {
    return { error: `label must be at most ${MAX_DICE_LABEL_LENGTH} characters.` };
  }
  if (actorReference !== undefined && actorReference.length > 100) {
    return { error: "actor must be at most 100 characters." };
  }
  return {
    count,
    sides,
    modifier,
    mode,
    ...(target !== undefined ? { target } : {}),
    ...(label !== undefined && label !== "" ? { label } : {}),
    ...(actorReference !== undefined && actorReference !== "" ? { actorReference } : {}),
  };
}

function createRollValues(
  input: NormalizedDiceRoll,
  randomInteger: (minimum: number, maximumExclusive: number) => number,
): Pick<DiceRollRow, "rolls" | "kept" | "total"> {
  const drawCount = input.mode === "normal" ? input.count : 2;
  const rolls = Array.from({ length: drawCount }, () => randomInteger(1, input.sides + 1));
  const kept = input.mode === "advantage"
    ? [Math.max(...rolls)]
    : input.mode === "disadvantage"
      ? [Math.min(...rolls)]
      : [...rolls];
  return {
    rolls,
    kept,
    total: kept.reduce((sum, value) => sum + value, 0) + input.modifier,
  };
}

function escapeDiscordDisplayText(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replaceAll("\\", "\\\\")
    .replace(/([*_`~|>])/g, "\\$1")
    .replaceAll("@", "@\u200B")
    .replaceAll("#", "#\u200B")
    .replaceAll(":", ":\u200B");
}

/** Render the immutable public ledger entry from a persisted roll. */
export function renderDiceRollMessage(roll: DiceRollRow): string {
  const actor = escapeDiscordDisplayText(roll.actorUsername);
  const label = roll.label === null ? "Dice roll" : escapeDiscordDisplayText(roll.label);
  const modifier = roll.modifier === 0 ? "" : ` ${roll.modifier > 0 ? "+" : "−"} ${Math.abs(roll.modifier)}`;
  const outcome = roll.target === null
    ? ""
    : `\n${roll.succeeded === true ? "✅ Success" : "❌ Failure"} · Target: \`${roll.target}\``;
  if (roll.mode === "normal") {
    const breakdown = roll.count === 1 && roll.modifier === 0
      ? ""
      : `\n${roll.count === 1 ? "Roll" : "Dice"}: \`${roll.rolls.join(", ")}\``;
    return `## 🎲 ${label}\n**${actor}** rolled \`${roll.count}d${roll.sides}${modifier}\`\n# ${roll.total}${outcome}${breakdown}`;
  }
  const kept = roll.kept[0];
  return `## 🎲 ${label}\n**${actor}** rolled \`1d${roll.sides} ${roll.mode}${modifier}\`\n# ${roll.total}${outcome}\nRolls: \`${roll.rolls.join(", ")}\` · Kept: \`${kept ?? "?"}\``;
}

function renderDiceRollToolResult(roll: DiceRollRow): string {
  const label = roll.label === null ? "none" : JSON.stringify(roll.label);
  const common = [
    `actor=${JSON.stringify(roll.actorUsername)}`,
    `label=${label}`,
    `dice=${roll.count}d${roll.sides}`,
    `rolls=[${roll.rolls.join(", ")}]`,
    `modifier=${roll.modifier}`,
    `total=${roll.total}`,
  ];
  if (roll.target !== null) {
    common.push(`target=${roll.target}`, `threshold_outcome=${roll.succeeded === true ? "success" : "failure"}`);
  }
  if (roll.mode === "normal") return common.join("; ");
  common.splice(3, 0, `mode=${roll.mode}`, `kept=${roll.kept[0] ?? "unknown"}`);
  return common.join("; ");
}

/** Create the public, cryptographically random roll_dice AgentTool. */
export function createDiceRollTool(deps: DiceRollToolDeps): AgentTool {
  return {
    name: "roll_dice",
    label: "Roll Dice",
    description: "Roll dice with cryptographic randomness and post the canonical result publicly.",
    parameters: DiceRollParams,
    execute: async (toolCallId, params, signal): Promise<AgentToolResult<DiceRollRow | { error: string }>> => {
      const normalized = normalizeDiceRollInput(params as DiceRollInput);
      if ("error" in normalized) {
        return {
          content: [{ type: "text", text: `Failed to roll dice: ${normalized.error}` }],
          details: { error: normalized.error },
        };
      }

      try {
        const requestKey = `${deps.guildId}:${deps.channelId}:${deps.currentRequest.sourceMessageId}:${toolCallId}`;
        let roll = getDiceRollByRequestKey(deps.db, requestKey);
        if (roll === null) {
          const actor = normalized.actorReference === undefined
            ? { userId: deps.currentRequest.requesterId, username: deps.currentRequest.requesterUsername }
            : await deps.resolveActor(normalized.actorReference);
          if (actor === null) {
            const error = `No exact guild user matched '${normalized.actorReference ?? ""}'. Use a mention, raw user ID, or exact username.`;
            return {
              content: [{ type: "text", text: `Failed to roll dice: ${error}` }],
              details: { error },
            };
          }

          const values = createRollValues(normalized, deps.randomInteger ?? randomInt);
          roll = createOrGetDiceRoll(deps.db, {
            requestKey,
            guildId: deps.guildId,
            channelId: deps.channelId,
            sourceMessageId: deps.currentRequest.sourceMessageId,
            requestedByUserId: deps.currentRequest.requesterId,
            actorUserId: actor.userId,
            actorUsername: actor.username,
            count: normalized.count,
            sides: normalized.sides,
            modifier: normalized.modifier,
            ...(normalized.target !== undefined ? { target: normalized.target } : {}),
            mode: normalized.mode,
            ...(normalized.label !== undefined ? { label: normalized.label } : {}),
            ...values,
          });
        }

        if (roll.resultMessageId !== null) {
          return {
            content: [{ type: "text", text: `Canonical public dice result: ${renderDiceRollToolResult(roll)}. Already posted as Discord message ${roll.resultMessageId}; do not repeat or alter it. Narrate only any useful consequence.` }],
            details: roll,
          };
        }

        const delivered = await deps.deliver({
          text: renderDiceRollMessage(roll),
          sourceMessageId: roll.sourceMessageId,
          dedupeKey: `dice-roll:${requestKey}`,
          ...(signal !== undefined ? { signal } : {}),
        });
        const completed = markDiceRollDelivered(deps.db, requestKey, delivered.sentMessageId);
        return {
          content: [{ type: "text", text: `Canonical public dice result: ${renderDiceRollToolResult(completed)}. Posted as Discord message ${completed.resultMessageId ?? delivered.sentMessageId}; do not repeat or alter it. Narrate only any useful consequence.` }],
          details: completed,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `Failed to roll dice: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}
