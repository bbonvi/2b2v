import type { InnerThread } from "../db/inner-thread-repository.ts";
import type { PrivateLifeConfig } from "./types.ts";
import {
  PRIVATE_LIFE_ACTION_SCOPES,
  PRIVATE_LIFE_ATTENTION_ORIGINS,
  PRIVATE_LIFE_CURIOSITY_MODES,
  PRIVATE_LIFE_TERRITORIES,
  type PrivateLifeDayPhase,
  type PrivateLifeSelection,
} from "./types.ts";

export interface RecentPrivateLifeTheme {
  label: string;
  themeKey: string;
  facets: string[];
  createdAt: number;
  territory: string;
  mode: string;
}

export interface PrivateLifeResidueChannel {
  guildId: string;
  channelId: string;
  messageCount: number;
  lastHumanActivityAt: number | null;
}

export interface PrivateLifeAttention {
  origin: PrivateLifeSelection["origin"];
  thread?: InnerThread;
}

const SEED_SUBJECTS: Record<(typeof PRIVATE_LIFE_TERRITORIES)[number], readonly string[]> = {
  open: ["an overlooked object", "an unfamiliar practice", "a private contradiction", "a useless fact", "a small experiment", "an accidental pattern", "a specific irritation", "an improbable place", "a physical technique", "a minor mystery", "a bad idea", "a forgotten possession"],
  external: ["an animal behavior", "an obscure profession", "a remote settlement", "an unusual law", "a street ritual", "a weather mechanism", "a transport system", "a medical practice", "a niche community", "a failed expedition", "a material supply chain", "an unfamiliar language feature"],
  "technical-material": ["a worn mechanical seal", "an unusual alloy", "a sensor failure", "a pressure system", "a fastening method", "a battery fault", "a damaged cable", "a fluid flow problem", "a manufacturing defect", "an optical mechanism", "a heat-transfer problem", "a repair with poor tools"],
  "creative-aesthetic": ["an ugly color pairing", "a constrained drawing", "a sound texture", "a damaged photograph", "an invented room", "an asymmetrical garment", "a tiny sculpture", "a false advertisement", "an unfinished story image", "a hostile interior", "a pleasing tool shape", "an accidental composition"],
  "mundane-private": ["laundry friction", "a food preparation failure", "a recurring domestic shortcut", "an annoying container", "a small purchase", "a private grooming habit", "a badly arranged drawer", "a sleep inconvenience", "an unnecessary possession", "a cleaning problem", "a clothing repair", "a minor administrative avoidance"],
  embodied: ["uneven pressure on skin", "a smell that lingers", "muscle fatigue", "temperature discomfort", "hair behaving badly", "a private hygiene detail", "a sensory pleasure", "a minor pain", "body image", "an awkward physical need", "breathing rhythm", "a texture against the body"],
  sexual: ["an unwanted arousal", "a specific private fantasy", "sexual curiosity without romance", "an embarrassing preference", "control and surrender", "a disappointing encounter candidate", "a physical fixation", "an intimate object", "private cleanup", "a boundary she wants", "a selfish desire", "an absurd erotic thought"],
  "social-personal": ["someone's repeated mannerism", "a person she misjudged", "an unanswered personal question", "a selective affection", "a private resentment", "a social test", "a lie told for convenience", "an unfamiliar person's appeal", "a boundary left unstated", "a small act of care", "jealous attention", "a conversation she might initiate"],
  community: ["a local in-joke", "a group habit", "an informal hierarchy", "a shared nuisance", "a disappearing custom", "a community rumor", "a moderation norm", "a collective blind spot", "a recurring argument", "a niche gathering", "a public space rule", "a strange local economy"],
  "transgressive-ugly": ["an act of petty cruelty", "a disgusting object", "a violent practical question", "a socially forbidden curiosity", "a selfish choice", "deliberate bad taste", "a destructive impulse", "an ugly bodily fact", "a dishonest advantage", "a humiliating possibility", "a morbid collection", "a thing she refuses to forgive"],
  "playful-absurd": ["a useless competition", "a stupid machine", "an animal with a job", "an impractical disguise", "a false scientific theory", "an object used incorrectly", "a private prank", "a terrible game rule", "an invented insult", "a tiny conspiracy", "an excessive solution", "a joke with no audience"],
};

const SEED_ANGLES = [
  "through a concrete failure",
  "through one sensory detail",
  "by comparing two incompatible versions",
  "as a question worth checking",
  "through a practical experiment",
  "from the least flattering angle",
  "as something recently noticed",
  "as an offscreen continuity candidate",
  "through an irrational preference",
  "by following its physical mechanism",
  "through one person's behavior",
  "without giving it symbolic meaning",
  "as a problem with no useful answer",
  "through an unexpected consequence",
  "as something she may want to make",
  "as something she may want to break",
  "through a private bodily response",
  "as a precise factual tangent",
  "through a choice she would not explain",
  "as an unfinished possibility",
] as const;

function minutes(clock: string): number {
  const [hour = "0", minute = "0"] = clock.split(":");
  return Number(hour) * 60 + Number(minute);
}

function inClockWindow(value: number, start: number, end: number): boolean {
  if (start === end) return true;
  return start < end ? value >= start && value < end : value >= start || value < end;
}

function localMinuteOfDay(now: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return value("hour") * 60 + value("minute");
}

function phaseForLocalMinute(config: PrivateLifeConfig, local: number): PrivateLifeDayPhase {
  if (inClockWindow(local, minutes(config.sleepStart), minutes(config.sleepEnd))) return "sleep-window";
  if (inClockWindow(local, minutes(config.lateNightStart), minutes(config.sleepStart))) return "late-night";
  return "day";
}

export function privateLifeDayPhase(
  config: PrivateLifeConfig,
  timezone: string,
  now = Date.now(),
): PrivateLifeDayPhase {
  return phaseForLocalMinute(config, localMinuteOfDay(now, timezone));
}

export function privateLifeNextDelayMs(
  config: PrivateLifeConfig,
  phase: PrivateLifeDayPhase,
  random = Math.random(),
): number {
  let weightedMinutes = 0;
  for (let minute = 0; minute < 1_440; minute += 1) {
    const minutePhase = phaseForLocalMinute(config, minute);
    weightedMinutes += minutePhase === "sleep-window"
      ? config.sleepRateMultiplier
      : minutePhase === "late-night"
        ? config.lateNightRateMultiplier
        : 1;
  }
  const base = weightedMinutes * 60_000 / config.opportunitiesPerDay;
  const rate = phase === "sleep-window"
    ? config.sleepRateMultiplier
    : phase === "late-night"
      ? config.lateNightRateMultiplier
      : 1;
  const jitter = 1 + (random * 2 - 1) * config.intervalJitter;
  return Math.max(1_000, Math.round(base * jitter / rate));
}

/** Find the next local phase change so a low night rate cannot delay the daytime schedule. */
export function privateLifePhaseBoundaryDelayMs(
  config: PrivateLifeConfig,
  timezone: string,
  now = Date.now(),
): number {
  const phase = privateLifeDayPhase(config, timezone, now);
  const minuteMs = 60_000;
  const coarseStepMs = 5 * minuteMs;
  for (let delay = coarseStepMs; delay <= 86_400_000 + coarseStepMs; delay += coarseStepMs) {
    if (privateLifeDayPhase(config, timezone, now + delay) === phase) continue;
    for (let exact = delay - coarseStepMs + minuteMs; exact <= delay; exact += minuteMs) {
      if (privateLifeDayPhase(config, timezone, now + exact) !== phase) return exact;
    }
  }
  return 86_400_000;
}

function weightedChoice<T extends string>(
  values: readonly T[],
  weight: (value: T) => number,
  random: () => number,
): T {
  const weighted = values.map((value) => ({ value, weight: Math.max(0, weight(value)) }));
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0) return values[0] as T;
  let cursor = random() * total;
  for (const item of weighted) {
    cursor -= item.weight;
    if (cursor <= 0) return item.value;
  }
  return weighted[weighted.length - 1]?.value ?? values[0] as T;
}

function recentCount(recent: readonly RecentPrivateLifeTheme[], key: "mode" | "territory", value: string): number {
  return recent.slice(0, 12).filter((theme) => theme[key] === value).length;
}

function noveltyMultiplier(count: number): number {
  return 1 / (1 + count * 0.42);
}

function nightModeMultiplier(mode: PrivateLifeSelection["mode"], phase: PrivateLifeDayPhase): number {
  if (phase === "day") return 1;
  if (phase === "sleep-window") {
    if (mode === "make-or-change" || mode === "social-impulse" || mode === "offscreen-event-candidate") return 0.08;
    if (mode === "unstructured" || mode === "imagine-possibility" || mode === "observe-or-collect") return 1.5;
    return 0.65;
  }
  if (mode === "make-or-change" || mode === "social-impulse") return 0.45;
  if (mode === "unstructured" || mode === "imagine-possibility") return 1.25;
  return 0.9;
}

function phaseActionScopeMultiplier(
  scope: PrivateLifeSelection["actionScope"],
  phase: PrivateLifeDayPhase,
): number {
  if (phase === "day") return 1;
  if (phase === "sleep-window") {
    if (scope === "reflect-only") return 3;
    if (scope === "quiet-exploration") return 0.04;
    return 0;
  }
  if (scope === "reflect-only") return 1.6;
  if (scope === "quiet-exploration") return 0.75;
  if (scope === "private-action") return 0.20;
  return 0.05;
}

function selectThread(threads: readonly InnerThread[], now: number, random: () => number): InnerThread | undefined {
  if (threads.length === 0) return undefined;
  const ids = threads.map((thread) => thread.id);
  const id = weightedChoice(ids, (candidateId) => {
    const thread = threads.find((item) => item.id === candidateId);
    if (thread === undefined) return 0;
    const ageDays = Math.min(30, Math.max(0, now - thread.updatedAt) / 86_400_000);
    return 0.1 + thread.salience * 0.35 + thread.pressure * 0.35 + ageDays / 30 * 0.20;
  }, random);
  return threads.find((thread) => thread.id === id);
}

/** Select the attention source before a runtime channel is chosen. */
export function selectPrivateLifeAttention(input: {
  config: PrivateLifeConfig;
  threads: readonly InnerThread[];
  recentResidueAvailable: boolean;
  origin?: PrivateLifeSelection["origin"];
  now?: number;
  random?: () => number;
}): PrivateLifeAttention {
  const random = input.random ?? Math.random;
  const now = input.now ?? Date.now();
  const origins = PRIVATE_LIFE_ATTENTION_ORIGINS.filter((origin) =>
    origin !== "continue-inner-thread" || input.threads.length > 0
  ).filter((origin) => origin !== "recent-residue" || input.recentResidueAvailable);
  const origin = input.origin !== undefined && origins.includes(input.origin)
    ? input.origin
    : weightedChoice(origins, (value) => input.config.originWeights[value], random);
  const thread = origin === "continue-inner-thread"
    ? selectThread(input.threads, now, random)
    : undefined;
  return {
    origin: thread === undefined && origin === "continue-inner-thread" ? "spontaneous" : origin,
    ...(thread !== undefined ? { thread } : {}),
  };
}

/** Report whether the candidate pool contains a recently active human room. */
export function hasPrivateLifeResidueChannel(input: {
  candidates: readonly PrivateLifeResidueChannel[];
  maxAgeHours: number;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  const maxAgeMs = input.maxAgeHours * 3_600_000;
  return input.candidates.some((candidate) => candidate.lastHumanActivityAt !== null
    && now - candidate.lastHumanActivityAt >= 0
    && now - candidate.lastHumanActivityAt <= maxAgeMs);
}

/** Choose one recent active room while softening raw message-count dominance. */
export function selectPrivateLifeResidueChannel(input: {
  candidates: readonly PrivateLifeResidueChannel[];
  maxAgeHours: number;
  now?: number;
  random?: () => number;
}): PrivateLifeResidueChannel | undefined {
  const random = input.random ?? Math.random;
  const now = input.now ?? Date.now();
  const maxAgeMs = input.maxAgeHours * 3_600_000;
  const eligible = input.candidates.filter((candidate) => candidate.lastHumanActivityAt !== null
    && now - candidate.lastHumanActivityAt >= 0
    && now - candidate.lastHumanActivityAt <= maxAgeMs);
  if (eligible.length === 0) return undefined;
  const indexes = eligible.map((_candidate, index) => String(index));
  const selected = weightedChoice(indexes, (value) => {
    const candidate = eligible[Number(value)];
    if (candidate === undefined || candidate.lastHumanActivityAt === null) return 0;
    const ageRatio = Math.min(1, (now - candidate.lastHumanActivityAt) / maxAgeMs);
    const recency = 0.2 + 0.8 * (1 - ageRatio);
    return Math.sqrt(Math.max(1, candidate.messageCount)) * recency;
  }, random);
  return eligible[Number(selected)];
}

function candidateSeeds(
  territory: PrivateLifeSelection["territory"],
  count: number,
  recent: readonly RecentPrivateLifeTheme[],
  random: () => number,
): string[] {
  const recentThemeTokens = recent.slice(0, 40).map((theme) => new Set(
    [theme.label, theme.themeKey, ...theme.facets]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length >= 4),
  ));
  const candidates = new Set<string>();
  const subjects = SEED_SUBJECTS[territory];
  const attempts = count * 20;
  for (let index = 0; index < attempts && candidates.size < count; index += 1) {
    const subject = subjects[Math.floor(random() * subjects.length)];
    const angle = SEED_ANGLES[Math.floor(random() * SEED_ANGLES.length)];
    if (subject === undefined || angle === undefined) continue;
    const subjectTokens = subject.toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length >= 4);
    const repeatsRecentTheme = subjectTokens.length > 0 && recentThemeTokens.some((tokens) =>
      subjectTokens.filter((token) => tokens.has(token)).length >= Math.min(2, subjectTokens.length)
    );
    const candidate = `${subject}, ${angle}`;
    if (!repeatsRecentTheme) candidates.add(candidate);
  }
  return [...candidates];
}

/** Select a broad lane and varied concrete seeds without treating the space as a checklist. */
export function selectPrivateLifeCuriosity(input: {
  config: PrivateLifeConfig;
  phase: PrivateLifeDayPhase;
  recent: readonly RecentPrivateLifeTheme[];
  threads: readonly InnerThread[];
  origin?: PrivateLifeSelection["origin"];
  mode?: PrivateLifeSelection["mode"];
  territory?: PrivateLifeSelection["territory"];
  actionScope?: PrivateLifeSelection["actionScope"];
  recentResidueAvailable?: boolean;
  socialOutputAvailable?: boolean;
  now?: number;
  random?: () => number;
}): PrivateLifeSelection {
  const random = input.random ?? Math.random;
  const now = input.now ?? Date.now();
  const attention = selectPrivateLifeAttention({
    config: input.config,
    threads: input.threads,
    recentResidueAvailable: input.recentResidueAvailable ?? false,
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    now,
    random,
  });
  const origin = attention.origin;
  const mode = input.mode ?? weightedChoice(
      PRIVATE_LIFE_CURIOSITY_MODES,
      (value) => input.config.modeWeights[value]
        * noveltyMultiplier(recentCount(input.recent, "mode", value))
        * nightModeMultiplier(value, input.phase),
      random,
    );
  const territory = input.territory ?? weightedChoice(
      PRIVATE_LIFE_TERRITORIES,
      (value) => input.config.territoryWeights[value]
        * noveltyMultiplier(recentCount(input.recent, "territory", value)),
      random,
    );
  const actionScope = input.actionScope ?? weightedChoice(
    PRIVATE_LIFE_ACTION_SCOPES,
    (value) => input.config.actionScopeWeights[value]
      * phaseActionScopeMultiplier(value, input.phase)
      * (value === "social-opportunity" && input.socialOutputAvailable === false ? 0 : 1),
    random,
  );
  const thread = attention.thread;
  const freshSeeds = candidateSeeds(territory, input.config.candidateCount, input.recent, random);
  return {
    origin: thread === undefined && origin === "continue-inner-thread" ? "spontaneous" : origin,
    mode,
    territory,
    actionScope,
    candidateSeeds: freshSeeds,
    ...(thread !== undefined ? {
      continuedThreadId: thread.id,
      continuedThreadContent: thread.content,
    } : {}),
  };
}
