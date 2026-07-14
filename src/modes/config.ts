import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parseDurationMs } from "./duration.ts";
import type {
  PersonaMode,
  PersonaModeActivityType,
  PersonaModeAvatarCandidate,
  PersonaModePresence,
  PersonaModePresenceStatus,
  PersonaModeScope,
  PersonaModesConfig,
  PersonaModesConfigYaml,
  PersonaModeWindow,
  PersonaModeYaml,
} from "./types.ts";

const MODE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const AVATAR_PATTERN = /^avatar(?:-([a-z0-9_-]+))?\.(png|jpe?g|webp)$/i;
const PRESENCE_STATUSES = new Set<PersonaModePresenceStatus>(["online", "idle", "dnd", "invisible"]);
const ACTIVITY_TYPES = new Set<PersonaModeActivityType>(["playing", "streaming", "listening", "watching", "custom", "competing"]);
const MODE_SCOPES = new Set<PersonaModeScope>(["global", "guild"]);

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function clockTime(value: unknown, field: string): string {
  const text = requiredString(value, field);
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (match === null || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`${field} must use HH:mm`);
  }
  return text;
}

function windows(value: unknown, field: string): PersonaModeWindow[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must contain at least one local-time window`);
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object") throw new Error(`${field}[${index}] must be an object`);
    const raw = entry as { start?: unknown; end?: unknown };
    return {
      start: clockTime(raw.start, `${field}[${index}].start`),
      end: clockTime(raw.end, `${field}[${index}].end`),
    };
  });
}

function instructionSource(
  inline: unknown,
  conventionalPath: string,
  field: string,
  required: boolean,
  allowEmpty = false,
): string | undefined {
  const hasFile = existsSync(conventionalPath);
  const hasInline = inline !== undefined;
  if (hasInline && typeof inline !== "string") throw new Error(`${field} must be a string`);
  if (hasInline && hasFile) {
    throw new Error(`${field} and ${conventionalPath} cannot both define the same mode phase`);
  }
  if (hasInline) {
    const inlineText = inline.trim();
    if (!allowEmpty && inlineText === "") throw new Error(`${field} must be a non-empty string`);
    return inlineText;
  }
  if (hasFile) {
    const fileText = readFileSync(conventionalPath, "utf8").trim();
    if (!allowEmpty && fileText === "") throw new Error(`${conventionalPath} must not be empty`);
    return fileText;
  }
  if (required) throw new Error(`${field} is required when ${conventionalPath} is absent`);
  return allowEmpty ? "" : undefined;
}

function discoverAvatars(modeDir: string, field: string): PersonaModeAvatarCandidate[] {
  if (!existsSync(modeDir)) throw new Error(`${field} mode directory is missing: ${modeDir}`);
  const candidates: PersonaModeAvatarCandidate[] = [];
  const stems = new Set<string>();
  for (const name of readdirSync(modeDir).sort((a, b) => a.localeCompare(b, "en"))) {
    const match = AVATAR_PATTERN.exec(name);
    if (match === null) continue;
    const stem = name.slice(0, name.lastIndexOf(".")).toLowerCase();
    if (stems.has(stem)) throw new Error(`${field} has duplicate avatar stem ${stem}`);
    stems.add(stem);
    const path = join(modeDir, name);
    const contentHash = createHash("sha256").update(readFileSync(path)).digest("hex");
    candidates.push({ id: name, path, contentHash });
  }
  if (candidates.length === 0) throw new Error(`${field} must provide avatar.png or avatar-<name>.<png|jpg|jpeg|webp>`);
  return candidates;
}

function resolvePresence(raw: PersonaModeYaml["presence"], field: string): PersonaModePresence | undefined {
  if (raw === undefined) return undefined;
  const status = requiredString(raw.status, `${field}.status`) as PersonaModePresenceStatus;
  if (!PRESENCE_STATUSES.has(status)) throw new Error(`${field}.status must be online, idle, dnd, or invisible`);
  if (raw.activity === undefined) return { status };
  const type = requiredString(raw.activity.type, `${field}.activity.type`) as PersonaModeActivityType;
  if (!ACTIVITY_TYPES.has(type)) {
    throw new Error(`${field}.activity.type must be playing, streaming, listening, watching, custom, or competing`);
  }
  const state = optionalString(raw.activity.state, `${field}.activity.state`);
  const url = optionalString(raw.activity.url, `${field}.activity.url`);
  return {
    status,
    activity: {
      type,
      name: requiredString(raw.activity.name, `${field}.activity.name`),
      ...(state !== undefined ? { state } : {}),
      ...(url !== undefined ? { url } : {}),
    },
  };
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${field} must be a positive integer`);
  return value as number;
}

function resolveMode(raw: PersonaModeYaml, profileRoot: string, index: number): PersonaMode {
  const field = `personaModes.modes[${index}]`;
  const id = requiredString(raw.id, `${field}.id`);
  if (!MODE_ID_PATTERN.test(id)) throw new Error(`${field}.id must match ${MODE_ID_PATTERN.source}`);
  const scope = (raw.scope === undefined ? "global" : requiredString(raw.scope, `${field}.scope`)) as PersonaModeScope;
  if (!MODE_SCOPES.has(scope)) throw new Error(`${field}.scope must be global or guild`);
  const modeDir = join(profileRoot, "modes", id);
  const instructions = instructionSource(raw.instructions, join(modeDir, "instructions.md"), `${field}.instructions`, false, true);
  const mode: PersonaMode = {
    id,
    scope,
    instructions: instructions ?? "",
    avatars: discoverAvatars(modeDir, field),
  };

  const rotation = raw.avatar?.rotation;
  if (rotation !== undefined) {
    const minIntervalMs = parseDurationMs(rotation.minInterval, `${field}.avatar.rotation.minInterval`);
    const maxIntervalMs = parseDurationMs(rotation.maxInterval, `${field}.avatar.rotation.maxInterval`);
    if (maxIntervalMs < minIntervalMs) throw new Error(`${field}.avatar.rotation.maxInterval must be >= minInterval`);
    mode.avatarRotation = { minIntervalMs, maxIntervalMs };
  }
  const presence = resolvePresence(raw.presence, `${field}.presence`);
  if (scope === "guild" && presence !== undefined) {
    throw new Error(`${field}.presence is not supported for guild-scoped modes because Discord presence is global`);
  }
  if (presence !== undefined) mode.presence = presence;

  if (raw.activation !== undefined) {
    const type = requiredString(raw.activation.type, `${field}.activation.type`);
    if (type === "scheduledWindow") {
      mode.activation = {
        type,
        windows: windows(raw.activation.windows, `${field}.activation.windows`),
      };
    } else if (type === "triggeredEpisode") {
      const minIntervalMs = parseDurationMs(
        raw.activation.minInterval,
        `${field}.activation.minInterval`,
        { allowZero: true },
      );
      const maxIntervalMs = parseDurationMs(raw.activation.maxInterval, `${field}.activation.maxInterval`);
      const cooldownMs = raw.activation.cooldown === undefined
        ? minIntervalMs
        : parseDurationMs(raw.activation.cooldown, `${field}.activation.cooldown`, { allowZero: true });
      const minDurationMs = parseDurationMs(raw.activation.minDuration, `${field}.activation.minDuration`);
      const maxDurationMs = parseDurationMs(raw.activation.maxDuration, `${field}.activation.maxDuration`);
      if (maxIntervalMs < minIntervalMs) throw new Error(`${field}.activation.maxInterval must be >= minInterval`);
      if (maxDurationMs < minDurationMs) throw new Error(`${field}.activation.maxDuration must be >= minDuration`);
      mode.activation = {
        type,
        minIntervalMs,
        maxIntervalMs,
        cooldownMs,
        minDurationMs,
        maxDurationMs,
        opportunityWindows: windows(raw.activation.opportunityWindows, `${field}.activation.opportunityWindows`),
        maxVisibleTurns: positiveInteger(raw.activation.maxVisibleTurns, `${field}.activation.maxVisibleTurns`),
      };
    } else {
      throw new Error(`${field}.activation.type must be scheduledWindow or triggeredEpisode`);
    }
  }

  if (raw.leadIn !== undefined) {
    if (mode.activation === undefined) throw new Error(`${field}.leadIn requires activation`);
    const leadInInstructions = instructionSource(
      raw.leadIn.instructions,
      join(modeDir, "lead-in.md"),
      `${field}.leadIn.instructions`,
      true,
    );
    if (leadInInstructions === undefined) throw new Error(`${field}.leadIn.instructions is required`);
    mode.leadIn = {
      durationMs: parseDurationMs(raw.leadIn.duration, `${field}.leadIn.duration`),
      instructions: leadInInstructions,
    };
  }

  if (raw.aftermath !== undefined) {
    const aftermathInstructions = instructionSource(
      raw.aftermath.instructions,
      join(modeDir, "aftermath.md"),
      `${field}.aftermath.instructions`,
      true,
    );
    if (aftermathInstructions === undefined) throw new Error(`${field}.aftermath.instructions is required`);
    if (raw.aftermath.consumeOnVisibleTurn !== undefined && typeof raw.aftermath.consumeOnVisibleTurn !== "boolean") {
      throw new Error(`${field}.aftermath.consumeOnVisibleTurn must be boolean`);
    }
    mode.aftermath = {
      maxAgeMs: parseDurationMs(raw.aftermath.maxAge, `${field}.aftermath.maxAge`),
      consumeOnVisibleTurn: raw.aftermath.consumeOnVisibleTurn ?? true,
      instructions: aftermathInstructions,
    };
  }
  return mode;
}

/** Resolve profile-local mode instructions and convention-based avatar candidates. */
export function resolvePersonaModesConfig(
  raw: PersonaModesConfigYaml | undefined,
  profileRoot: string,
): PersonaModesConfig | undefined {
  if (raw === undefined) return undefined;
  const defaultModeId = requiredString(raw.default, "personaModes.default");
  if (!Array.isArray(raw.modes) || raw.modes.length === 0) throw new Error("personaModes.modes must be a non-empty array");
  const modes = raw.modes.map((entry, index) => {
    if (entry === null || typeof entry !== "object") throw new Error(`personaModes.modes[${index}] must be an object`);
    return resolveMode(entry as PersonaModeYaml, profileRoot, index);
  });
  const ids = modes.map((mode) => mode.id);
  if (new Set(ids).size !== ids.length) throw new Error("personaModes.modes must not contain duplicate ids");
  if (!ids.includes(defaultModeId)) throw new Error(`personaModes.default references unknown mode ${defaultModeId}`);
  const defaultMode = modes.find((mode) => mode.id === defaultModeId);
  if (defaultMode?.activation !== undefined) throw new Error("personaModes.default mode must not define activation");
  if (defaultMode?.scope !== "global") throw new Error("personaModes.default mode must be global");
  return { defaultModeId, modes };
}
