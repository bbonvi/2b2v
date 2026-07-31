import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "../db/database.ts";
import {
  createMemory,
  deleteMemory,
  getMemory,
  isMemoryKind,
  MEMORY_KINDS,
  updateMemory,
  type MemoryAbout,
  type MemoryKind,
  type MemoryRow,
} from "../db/memory-repository.ts";
import { completeLlmChat } from "../llm/chat.ts";
import type { OpenRouterChatRequest } from "../llm/types.ts";
import type { LlmProvider, PromptCachingConfig } from "../config/types.ts";
import { prependStableSectionsToPayload, type StablePromptSection } from "./prompt-cache.ts";
import { currentLocalContext } from "../time/agent-time.ts";
import {
  isRelativeDuration,
  RelativeDurationSchema,
  relativeDurationToMilliseconds,
  type RelativeDuration,
} from "../time/relative-duration.ts";
import { buildMemoryContext, buildMemoryPolicyInstructions } from "./memory-context.ts";

export interface MemoryExtractionInput {
  db: Database;
  guildId: string;
  currentUserId: string;
  currentUsername: string;
  sourceMessageId: string;
  userMessage: string;
  assistantReply: string;
  recentContext: string;
  timezone?: string;
  provider?: LlmProvider;
  apiKey: string;
  model: string;
  providerParams?: Record<string, unknown>;
  promptCaching: PromptCachingConfig;
  signal?: AbortSignal;
  onPayload?: (payload: unknown) => void;
  onCompletion?: (message: Record<string, unknown>) => void;
  completeChat?: (request: OpenRouterChatRequest) => Promise<{ text: string; messageForLogs: Record<string, unknown> }>;
}

export interface RecordMemoryToolDeps {
  db: Database;
  guildId: string;
  currentUserId: string;
  currentUsername?: string;
  sourceMessageId: string;
  /** Externalized record_memory tool description. */
  recordMemoryDescription?: string;
  /** Run validation and result counting without persisting changes. */
  dryRun?: boolean;
  /** Resolve a Discord username, with or without @, to a guild-scoped user ID. */
  resolveUsername?: (username: string) => Promise<string | undefined>;
}

type RecordMemoryToolResult = AgentToolResult<{ applied: number; requested: number } | { error: true }>;

interface MemoryMutationInput {
  db: Database;
  guildId: string;
  currentUserId: string;
  currentUsername?: string;
  sourceMessageId: string;
  resolveUsername?: (username: string) => Promise<string | undefined>;
}

type MemoryRecallInInput = "anywhere" | "current_guild";
type MemoryRecallWhenInput = "always" | { users_present: string[] };
const MAX_SCRATCHPAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type ExpiresIn = RelativeDuration;
const ExpiresInSchema = RelativeDurationSchema;

const MemoryRecallWhenSchema = Type.Union([
  Type.Literal("always"),
  Type.Object({
    users_present: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  }, { additionalProperties: false }),
]);

const MemoryWriteProperties = {
  about: Type.Union([Type.Literal("community"), Type.Literal("user"), Type.Literal("self")]),
  username: Type.Optional(Type.String({ minLength: 1 })),
  kind: Type.String({ enum: [...MEMORY_KINDS] }),
  content: Type.String({ minLength: 1 }),
  source_message_id: Type.Optional(Type.Union([
    Type.String({ minLength: 1 }),
    Type.Null(),
  ])),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  important: Type.Optional(Type.Boolean()),
  importantUntil: Type.Optional(Type.Union([ExpiresInSchema, Type.Null()])),
  expiresIn: Type.Optional(Type.Union([ExpiresInSchema, Type.Null()])),
};

const MemoryWriteActionSchema = Type.Union([
  Type.Object({
    action: Type.Literal("create"),
    ...MemoryWriteProperties,
    recall_in: Type.Optional(Type.Union([Type.Literal("anywhere"), Type.Literal("current_guild")])),
    recall_when: Type.Optional(MemoryRecallWhenSchema),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("update"),
    id: Type.Integer({ minimum: 1 }),
    ...MemoryWriteProperties,
    recall_in: Type.Union([Type.Literal("anywhere"), Type.Literal("current_guild")]),
    recall_when: MemoryRecallWhenSchema,
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("delete"),
    id: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
]);

const MemoryActionSchema = Type.Union([
  Type.Object({
    action: Type.Literal("none"),
  }, { additionalProperties: false }),
  MemoryWriteActionSchema,
]);

const MemoryExtractionSchema = Type.Object({
  actions: Type.Array(MemoryActionSchema, { maxItems: 20 }),
}, { additionalProperties: false });

const RecordMemoryToolSchema = Type.Object({
  actions: Type.Array(MemoryWriteActionSchema, { minItems: 1, maxItems: 20 }),
}, { additionalProperties: false });

type MemoryExtraction = {
  actions: Array<
    | { action: "none" }
    | {
      action: "create";
      about: MemoryAbout;
      username?: string;
      recall_in?: MemoryRecallInInput;
      recall_when?: MemoryRecallWhenInput;
      kind: MemoryKind;
      content: string;
      source_message_id?: string | null;
      confidence?: number;
      important?: boolean;
      importantUntil?: ExpiresIn | null;
      expiresIn?: ExpiresIn | null;
    }
    | {
      action: "update";
      id: number;
      about: MemoryAbout;
      username?: string;
      recall_in: MemoryRecallInInput;
      recall_when: MemoryRecallWhenInput;
      kind: MemoryKind;
      content: string;
      source_message_id?: string | null;
      confidence?: number;
      important?: boolean;
      importantUntil?: ExpiresIn | null;
      expiresIn?: ExpiresIn | null;
    }
    | { action: "delete"; id: number }
  >;
};

type MemoryWriteAction = Extract<MemoryExtraction["actions"][number], { about: MemoryAbout }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function memoryClockContext(timezone: string | undefined, now = Date.now()): string {
  const tz = timezone ?? "UTC";
  return currentLocalContext(tz, now);
}

function normalizeUsername(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const username = value.trim().replace(/^@+/, "").trim();
  return username !== "" ? username : undefined;
}

function normalizeUsernameList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value
    .map((entry) => normalizeUsername(entry))
    .filter((entry): entry is string => entry !== undefined))];
}

function normalizeRecallWhen(
  value: unknown,
  about: MemoryAbout,
  username: string | undefined,
): MemoryRecallWhenInput | undefined {
  if (value === "always") return "always";
  if (isRecord(value)) {
    const usernames = normalizeUsernameList(value.users_present);
    if (usernames !== undefined && usernames.length > 0) return { users_present: usernames };
  }
  if (value !== undefined) return undefined;
  return about === "user" && username !== undefined ? { users_present: [username] } : "always";
}

function normalizeAbout(value: unknown): MemoryAbout | null {
  return value === "community" || value === "self" || value === "user" ? value : null;
}

function normalizeRecallIn(value: unknown, about: MemoryAbout): MemoryRecallInInput | undefined {
  if (value === "anywhere" || value === "current_guild") return value;
  if (value !== undefined) return undefined;
  return about === "community" ? "current_guild" : "anywhere";
}

function normalizeKind(value: unknown): MemoryKind | null {
  return isMemoryKind(value) ? value : null;
}

function normalizeExpiresIn(value: unknown): ExpiresIn | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return isRelativeDuration(value) ? value : undefined;
}

function expiresInToExpiresAt(expiresIn: ExpiresIn, now = Date.now()): number {
  return now + relativeDurationToMilliseconds(expiresIn);
}

function scratchpadExpiryIsValid(
  action: MemoryWriteAction,
  existing: MemoryRow | null,
): boolean {
  if (action.kind !== "scratchpad") return true;
  if (action.expiresIn === null) return false;
  if (action.expiresIn !== undefined) return relativeDurationToMilliseconds(action.expiresIn) <= MAX_SCRATCHPAD_TTL_MS;
  return existing?.kind === "scratchpad" && existing.expiresAt !== null;
}

function memoryKindAboutIsValid(kind: MemoryKind, about: MemoryAbout): boolean {
  return kind !== "journal" || about === "self";
}

function normalizeExtractionAction(value: unknown): MemoryExtraction["actions"][number] | null {
  if (!isRecord(value)) return null;
  const rawAction = value.action;
  if (rawAction === "none") return { action: "none" };

  if (rawAction === "delete") {
    const id = value.id;
    return typeof id === "number" && Number.isInteger(id) && id > 0 ? { action: "delete", id } : null;
  }

  if (rawAction === "create" || rawAction === "update") {
    const content = typeof value.content === "string" ? value.content.trim() : "";
    if (content === "") return null;
    const id = typeof value.id === "number" && Number.isInteger(value.id) && value.id > 0 ? value.id : undefined;
    const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
      ? Math.max(0, Math.min(1, value.confidence))
      : undefined;
    if ("expiresAt" in value) return null;
    const expiresIn = normalizeExpiresIn(value.expiresIn);
    if ("expiresIn" in value && expiresIn === undefined) return null;
    const importantUntil = normalizeExpiresIn(value.importantUntil);
    if ("importantUntil" in value && importantUntil === undefined) return null;
    const kind = "kind" in value ? normalizeKind(value.kind) : "fact";
    if (kind === null) return null;
    const about = normalizeAbout(value.about);
    if (about === null) return null;
    const username = normalizeUsername(value.username);
    const recallIn = normalizeRecallIn(value.recall_in, about);
    const recallWhen = normalizeRecallWhen(value.recall_when, about, username);
    if (recallIn === undefined || recallWhen === undefined) return null;
    const action = rawAction;
    if (action === "update" && id === undefined) return null;
    const normalized = {
      about,
      ...(username !== undefined ? { username } : {}),
      recall_in: recallIn,
      recall_when: recallWhen,
      kind,
      content,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(typeof value.important === "boolean" ? { important: value.important } : {}),
      ...(importantUntil !== undefined ? { importantUntil } : {}),
      ...(expiresIn !== undefined ? { expiresIn } : {}),
    };
    return action === "update" && id !== undefined
      ? { action, id, ...normalized }
      : { action: "create", ...normalized };
  }

  return null;
}

function normalizeExtractionShape(parsed: unknown): unknown {
  const rawActions = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.actions)
      ? parsed.actions
      : null;
  if (rawActions === null) return parsed;

  const actions = rawActions
    .slice(0, 20)
    .map(normalizeExtractionAction)
    .filter((action): action is NonNullable<typeof action> => action !== null);
  return { actions: actions.length > 0 ? actions : [{ action: "none" }] };
}

function parseExtraction(rawText: string): MemoryExtraction | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
  parsed = normalizeExtractionShape(parsed);
  if (!Value.Check(MemoryExtractionSchema, parsed)) return null;
  return parsed as MemoryExtraction;
}

function memoryExtractionResponseFormat(): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: "memory_extraction",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["actions"],
        properties: {
          actions: {
            type: "array",
            maxItems: 20,
            items: {
              anyOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["action"],
                  properties: { action: { const: "none" } },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["action", "about", "kind", "content"],
                  properties: {
                    action: { const: "create" },
                    about: { type: "string", enum: ["community", "user", "self"] },
                    username: { type: "string", minLength: 1 },
                    recall_in: { type: "string", enum: ["anywhere", "current_guild"] },
                    recall_when: {
                      anyOf: [
                        { const: "always" },
                        {
                          type: "object",
                          additionalProperties: false,
                          required: ["users_present"],
                          properties: {
                            users_present: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
                          },
                        },
                      ],
                    },
                    kind: { type: "string", enum: [...MEMORY_KINDS] },
                    content: { type: "string", minLength: 1 },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    important: { type: "boolean" },
                    importantUntil: {
                      anyOf: [
                        {
                          type: "object",
                          additionalProperties: false,
                          required: ["amount", "unit"],
                          properties: {
                            amount: { type: "number", exclusiveMinimum: 0 },
                            unit: { type: "string", enum: ["minutes", "hours", "days", "weeks", "months"] },
                          },
                        },
                        { type: "null" },
                      ],
                    },
                    expiresIn: {
                      anyOf: [
                        {
                          type: "object",
                          additionalProperties: false,
                          required: ["amount", "unit"],
                          properties: {
                            amount: { type: "number", exclusiveMinimum: 0 },
                            unit: { type: "string", enum: ["minutes", "hours", "days", "weeks", "months"] },
                          },
                        },
                        { type: "null" },
                      ],
                    },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["action", "id", "about", "recall_in", "recall_when", "kind", "content"],
                  properties: {
                    action: { const: "update" },
                    id: { type: "integer", minimum: 1 },
                    about: { type: "string", enum: ["community", "user", "self"] },
                    username: { type: "string", minLength: 1 },
                    recall_in: { type: "string", enum: ["anywhere", "current_guild"] },
                    recall_when: {
                      anyOf: [
                        { const: "always" },
                        {
                          type: "object",
                          additionalProperties: false,
                          required: ["users_present"],
                          properties: {
                            users_present: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
                          },
                        },
                      ],
                    },
                    kind: { type: "string", enum: [...MEMORY_KINDS] },
                    content: { type: "string", minLength: 1 },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
                    important: { type: "boolean" },
                    importantUntil: {
                      anyOf: [
                        {
                          type: "object",
                          additionalProperties: false,
                          required: ["amount", "unit"],
                          properties: {
                            amount: { type: "number", exclusiveMinimum: 0 },
                            unit: { type: "string", enum: ["minutes", "hours", "days", "weeks", "months"] },
                          },
                        },
                        { type: "null" },
                      ],
                    },
                    expiresIn: {
                      anyOf: [
                        {
                          type: "object",
                          additionalProperties: false,
                          required: ["amount", "unit"],
                          properties: {
                            amount: { type: "number", exclusiveMinimum: 0 },
                            unit: { type: "string", enum: ["minutes", "hours", "days", "weeks", "months"] },
                          },
                        },
                        { type: "null" },
                      ],
                    },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["action", "id"],
                  properties: {
                    action: { const: "delete" },
                    id: { type: "integer", minimum: 1 },
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
}

function buildExtractionPrompt(input: MemoryExtractionInput): string {
  const current = buildMemoryContext({
    db: input.db,
    guildId: input.guildId,
    currentUserId: input.currentUserId,
  });
  return [
    "Extract only durable memory updates or short-lived scratchpad updates from this Discord exchange.",
    ...buildMemoryPolicyInstructions(),
    "If Existing memories is (none), deletion and update are impossible; return none or create only.",
    "",
    "Existing memories:",
    current !== "" ? current : "(none)",
    "",
    "Current time for expiresIn and importantUntil decisions:",
    memoryClockContext(input.timezone),
    "",
    ...(input.recentContext.trim() !== ""
      ? [
          "Recent chat context:",
          input.recentContext.trim(),
          "",
        ]
      : []),
    `Current speaker: @${input.currentUsername} (${input.currentUserId})`,
    `User message: ${input.userMessage}`,
    `Bot reply: ${input.assistantReply}`,
  ].join("\n");
}

function editableMemory(input: MemoryMutationInput, id: number): MemoryRow | null {
  const existing = getMemory(input.db, id);
  if (existing === null) return null;
  if (existing.recallIn !== "anywhere" && existing.recallIn.guildId !== input.guildId) return null;
  return existing;
}

interface MemoryActionTarget {
  about: MemoryAbout;
  aboutUserId: string | null;
}

async function resolveUserReference(
  input: MemoryMutationInput,
  username: string,
): Promise<string> {
  const normalized = normalizeUsername(username);
  if (normalized === undefined) throw new Error("Memory user reference cannot be empty.");
  if (input.currentUsername !== undefined && normalized.toLowerCase() === input.currentUsername.toLowerCase()) {
    return input.currentUserId;
  }
  const explicitId = /^(?:user:)?(\d{17,20})$/.exec(normalized)?.[1];
  if (explicitId !== undefined) return explicitId;
  const userId = await input.resolveUsername?.(normalized);
  if (userId === undefined) throw new Error(`Could not resolve memory user @${normalized}.`);
  return userId;
}

async function resolveRecallWhen(
  input: MemoryMutationInput,
  recallWhen: MemoryRecallWhenInput,
): Promise<"always" | string[]> {
  if (recallWhen === "always") return "always";
  const userIds: string[] = [];
  for (const username of recallWhen.users_present) userIds.push(await resolveUserReference(input, username));
  return [...new Set(userIds)];
}

async function actionMemoryTarget(
  input: MemoryMutationInput,
  action: MemoryWriteAction,
): Promise<MemoryActionTarget> {
  if (action.about === "self") return { about: "self", aboutUserId: null };
  if (action.about === "community") return { about: "community", aboutUserId: null };

  const username = normalizeUsername(action.username);
  if (username === undefined) throw new Error("User memories require username.");
  return { about: "user", aboutUserId: await resolveUserReference(input, username) };
}

type PreparedMemoryMutation =
  | { action: "create"; input: Parameters<typeof createMemory>[1] }
  | { action: "update"; id: number; input: Parameters<typeof updateMemory>[2] }
  | { action: "delete"; id: number };

async function prepareMemoryActions(
  input: MemoryMutationInput,
  extraction: MemoryExtraction,
): Promise<PreparedMemoryMutation[]> {
  const prepared: PreparedMemoryMutation[] = [];
  const mutatedIds = new Set<number>();
  for (const action of extraction.actions) {
    if (action.action === "none") continue;
    if (action.action === "delete") {
      if (editableMemory(input, action.id) === null) throw new Error(`Memory ${action.id} is not editable from this guild.`);
      if (mutatedIds.has(action.id)) throw new Error(`Memory ${action.id} has multiple mutations in one batch.`);
      mutatedIds.add(action.id);
      prepared.push(action);
      continue;
    }

    const existing = action.action === "update" ? editableMemory(input, action.id) : null;
    if (action.action === "update" && existing === null) {
      throw new Error(`Memory ${action.id} is not editable from this guild.`);
    }
    if (action.action === "update") {
      if (mutatedIds.has(action.id)) throw new Error(`Memory ${action.id} has multiple mutations in one batch.`);
      mutatedIds.add(action.id);
    }

    const target = await actionMemoryTarget(input, action);
    const recallIn = action.recall_in ?? (target.about === "community" ? "current_guild" : "anywhere");
    const recallWhen = action.recall_when === undefined
      ? target.about === "user" && target.aboutUserId !== null ? [target.aboutUserId] : "always"
      : await resolveRecallWhen(input, action.recall_when);
    if (!memoryKindAboutIsValid(action.kind, target.about)) throw new Error("Journal memories must be about self.");
    if (target.about === "community" && recallIn !== "current_guild") {
      throw new Error("Community memories must be recalled in the current guild.");
    }
    if (!scratchpadExpiryIsValid(action, existing)) throw new Error("Scratchpad memories require expiresIn of at most seven days.");
    const isImportant = action.important ?? (existing?.priority ?? 0) > 0;
    if (action.importantUntil !== undefined && action.importantUntil !== null && !isImportant) {
      throw new Error("importantUntil requires important=true.");
    }
    const expiresAt = action.expiresIn === undefined
      ? undefined
      : action.expiresIn === null
        ? null
        : expiresInToExpiresAt(action.expiresIn);
    const importantUntil = action.importantUntil === undefined
      ? undefined
      : action.importantUntil === null
        ? null
        : expiresInToExpiresAt(action.importantUntil);
    const common = {
      about: target.about,
      aboutUserId: target.aboutUserId,
      recallIn: recallIn === "anywhere" ? "anywhere" as const : { guildId: input.guildId },
      recallWhen,
      kind: action.kind,
      content: action.content.trim(),
      ...(action.source_message_id !== undefined ? { sourceMessageId: action.source_message_id } : {}),
      confidence: action.confidence,
      ...(action.important !== undefined ? { priority: action.important ? 1 : 0 } : {}),
      ...(importantUntil !== undefined ? { importantUntil } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    if (common.content === "") throw new Error("Memory content cannot be empty.");

    if (action.action === "update") {
      prepared.push({ action: "update", id: action.id, input: common });
    } else {
      prepared.push({
        action: "create",
        input: {
          guildId: input.guildId,
          ...common,
        },
      });
    }
  }
  return prepared;
}

async function applyMemoryActions(
  input: MemoryMutationInput,
  extraction: MemoryExtraction,
  dryRun = false,
): Promise<number> {
  const prepared = await prepareMemoryActions(input, extraction);
  const savepoint = `memory_batch_${crypto.randomUUID().replaceAll("-", "")}`;
  input.db.raw.run(`SAVEPOINT ${savepoint}`);
  try {
    for (const mutation of prepared) {
      if (mutation.action === "create") {
        createMemory(input.db, mutation.input);
      } else if (mutation.action === "update") {
        if (!updateMemory(input.db, mutation.id, mutation.input)) throw new Error(`Memory ${mutation.id} disappeared during update.`);
      } else if (!deleteMemory(input.db, mutation.id)) {
        throw new Error(`Memory ${mutation.id} disappeared during deletion.`);
      }
    }
    if (dryRun) input.db.raw.run(`ROLLBACK TO ${savepoint}`);
    input.db.raw.run(`RELEASE ${savepoint}`);
    return prepared.length;
  } catch (error) {
    try {
      input.db.raw.run(`ROLLBACK TO ${savepoint}`);
      input.db.raw.run(`RELEASE ${savepoint}`);
    } catch {
      // Preserve the original tool failure if rollback cleanup itself fails.
    }
    throw error;
  }
}

/** Create the state-changing tool used by the silent post-reply memory pass. */
export function createRecordMemoryTool(deps: RecordMemoryToolDeps): AgentTool {
  const description = deps.recordMemoryDescription?.trim();
  return {
    name: "record_memory",
    label: "record_memory",
    description: description?.trim() ?? "",
    parameters: RecordMemoryToolSchema,

    async execute(_toolCallId: string, params: unknown): Promise<RecordMemoryToolResult> {
      if (!Value.Check(RecordMemoryToolSchema, params)) {
        return {
          content: [{ type: "text", text: "Memory update rejected: arguments did not match the schema." }],
          details: { error: true },
        };
      }

      const extraction = params as MemoryExtraction;
      try {
        const applied = await applyMemoryActions(deps, extraction, deps.dryRun === true);
        return {
          content: [{ type: "text", text: `Memory update complete; applied ${applied} of ${extraction.actions.length} requested action(s).` }],
          details: { applied, requested: extraction.actions.length },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Memory update rejected: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }
    },
  };
}

/** Run background memory extraction and apply accepted updates. */
export async function extractAndApplyMemories(input: MemoryExtractionInput): Promise<void> {
  const complete = input.completeChat ?? completeLlmChat;
  const stable: StablePromptSection[] = [{
    role: "system",
    text: "You are a memory extraction task; return only JSON matching the schema.",
  }];
  const result = await complete({
    provider: input.provider,
    apiKey: input.apiKey,
    model: input.model,
    systemPrompt: input.provider === "openai-codex" ? stable.map((section) => section.text).join("\n\n") : "",
    messages: [{ role: "user", content: buildExtractionPrompt(input) }],
    providerParams: input.providerParams,
    responseFormat: memoryExtractionResponseFormat(),
    signal: input.signal,
    onPayload: (payload) => {
      if (input.provider !== "openai-codex") {
        prependStableSectionsToPayload(payload, stable, input.promptCaching, input.model);
      }
      input.onPayload?.(payload);
    },
  });
  input.onCompletion?.(result.messageForLogs);

  const extracted = parseExtraction(result.text);
  if (extracted === null) return;

  await applyMemoryActions(input, extracted);
}

