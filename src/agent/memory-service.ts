import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Database } from "../db/database";
import {
  createMemory,
  deleteMemory,
  getMemory,
  listMemories,
  updateMemory,
  type MemoryKind,
  type MemoryRow,
} from "../db/memory-repository";
import { completeLlmChat, type OpenRouterChatRequest } from "../llm/openrouter-chat";
import type { LlmProvider, PromptCachingConfig } from "../config/types";
import { prependStableSectionsToPayload, type StablePromptSection } from "./prompt-cache";

export interface MemoryContextInput {
  db: Database;
  guildId: string;
  currentUserId: string;
  resolveUserId?: (userId: string) => string | undefined;
  limit?: number;
}

export interface MemoryExtractionInput {
  db: Database;
  guildId: string;
  currentUserId: string;
  currentUsername: string;
  sourceMessageId: string;
  userMessage: string;
  assistantReply: string;
  recentContext: string;
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

const MemoryActionSchema = Type.Union([
  Type.Object({
    action: Type.Literal("none"),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("upsert"),
    id: Type.Optional(Type.Integer({ minimum: 1 })),
    subject: Type.Union([Type.Literal("global"), Type.Literal("current_user")]),
    kind: Type.Union([
      Type.Literal("global_note"),
      Type.Literal("user_note"),
      Type.Literal("preference"),
      Type.Literal("relationship"),
      Type.Literal("project"),
      Type.Literal("fact"),
    ]),
    content: Type.String({ minLength: 1 }),
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal("delete"),
    id: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
]);

const MemoryExtractionSchema = Type.Object({
  actions: Type.Array(MemoryActionSchema, { maxItems: 5 }),
}, { additionalProperties: false });

type MemoryExtraction = {
  actions: Array<
    | { action: "none" }
    | {
      action: "upsert";
      id?: number;
      subject: "global" | "current_user";
      kind: MemoryKind;
      content: string;
      confidence?: number;
    }
    | { action: "delete"; id: number }
  >;
};

const MEMORY_KINDS = ["global_note", "user_note", "preference", "relationship", "project", "fact"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scopeLabel(row: MemoryRow, resolveUserId?: (userId: string) => string | undefined): string {
  if (row.subjectUserId === null) return "global";
  const username = resolveUserId?.(row.subjectUserId);
  return username !== undefined && username !== "" ? `@${username}` : `user:${row.subjectUserId}`;
}

/** Build the uncached memory block injected into the conversation prompt. */
export function buildMemoryContext(input: MemoryContextInput): string {
  const rows = listMemories(input.db, {
    guildId: input.guildId,
    subjectUserId: input.currentUserId,
    includeGlobal: true,
    limit: input.limit ?? 40,
  }).filter((row) => row.content.trim() !== "");

  if (rows.length === 0) return "";

  const lines = rows.map((row) => {
    const label = scopeLabel(row, input.resolveUserId);
    return `- ${row.id} [${label}] [${row.kind}] ${row.content}`;
  });
  return [
    "Use these durable memories as background context. Current chat instructions override memory.",
    ...lines,
  ].join("\n");
}

function normalizeSubject(value: unknown): "global" | "current_user" {
  return value === "global" || value === "server" ? "global" : "current_user";
}

function normalizeKind(value: unknown): MemoryKind {
  return typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value)
    ? value as MemoryKind
    : "fact";
}

function normalizeExtractionAction(value: unknown): MemoryExtraction["actions"][number] | null {
  if (!isRecord(value)) return null;
  const rawAction = value.action;
  if (rawAction === "none") return { action: "none" };

  if (rawAction === "delete") {
    const id = value.id;
    return typeof id === "number" && Number.isInteger(id) && id > 0 ? { action: "delete", id } : null;
  }

  if (rawAction === "upsert" || rawAction === "add" || rawAction === "create" || rawAction === "update") {
    const content = typeof value.content === "string" ? value.content.trim() : "";
    if (content === "") return null;
    const id = typeof value.id === "number" && Number.isInteger(value.id) && value.id > 0 ? value.id : undefined;
    const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
      ? Math.max(0, Math.min(1, value.confidence))
      : undefined;
    return {
      action: "upsert",
      ...(id !== undefined ? { id } : {}),
      subject: normalizeSubject(value.subject),
      kind: normalizeKind(value.kind),
      content,
      ...(confidence !== undefined ? { confidence } : {}),
    };
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
    .slice(0, 5)
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
            maxItems: 5,
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
                  required: ["action", "subject", "kind", "content"],
                  properties: {
                    action: { const: "upsert" },
                    id: { type: "integer", minimum: 1 },
                    subject: { type: "string", enum: ["global", "current_user"] },
                    kind: { type: "string", enum: ["global_note", "user_note", "preference", "relationship", "project", "fact"] },
                    content: { type: "string", minLength: 1 },
                    confidence: { type: "number", minimum: 0, maximum: 1 },
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
    "Extract only durable memory updates from this Discord exchange.",
    "Preserve a memory only if it is likely to be useful in a future conversation or future bot decision.",
    "If the fact cannot change how the bot should reply or act later, return action=none.",
    "Save stable user preferences, preferred or real names, explicit name/pronoun/language corrections, long-term facts, recurring project context, relationships, and explicit corrections.",
    "Do not save jokes, transient moods, ordinary chat, pleasantries, reactions, filler, or one-off requests.",
    "When in doubt, do not save it.",
    "Prefer updating an existing memory id over creating duplicates.",
    "Only delete a memory when an existing memory is listed below and the new chat clearly makes that specific memory obsolete or false.",
    "If Existing memories is (none), deletion is impossible; return none or upsert only. Never invent memory ids.",
    "Use subject=current_user for facts about the triggering user; use subject=global for shared server/project context.",
    "Do not persist facts that come only from system/developer context, persona, tool instructions, or bot implementation details.",
    "Focus on what the human user newly revealed or corrected in the chat exchange.",
    "If the user asks to remember something, treat that as strong intent to preserve the underlying fact/preference if it can matter later.",
    "If the bot reply says it will remember something, do not save the promise itself; save the user's underlying fact/preference when it is future-useful.",
    "Use the bot's apparent persona and speaking style as a tie-breaker: save details that would change future rapport, teasing, tone, help, or decisions for this persona.",
    "Do not save trivia just because the persona might find it interesting.",
    "You may also record a durable fact from recent chat context if the current exchange makes its importance clear; do not limit yourself to the last message.",
    "If the user says their name, preferred name, or corrects what they should be called, preserve it as current_user unless it is obviously a joke or roleplay.",
    "",
    "Existing memories:",
    current !== "" ? current : "(none)",
    "",
    ...(input.recentContext.trim() !== ""
      ? [
          "Recent chat context:",
          input.recentContext.trim(),
          "",
        ]
      : []),
    `Current user: @${input.currentUsername} (${input.currentUserId})`,
    `User message: ${input.userMessage}`,
    `Bot reply: ${input.assistantReply}`,
  ].join("\n");
}

function editableMemory(input: MemoryExtractionInput, id: number): MemoryRow | null {
  const existing = getMemory(input.db, id);
  if (existing === null) return null;
  if (existing.guildId !== input.guildId) return null;
  if (existing.subjectUserId !== null && existing.subjectUserId !== input.currentUserId) return null;
  return existing;
}

function duplicateMemory(
  input: MemoryExtractionInput,
  subjectUserId: string | null,
  kind: MemoryKind,
  content: string,
): MemoryRow | null {
  const normalized = content.trim().toLowerCase();
  const rows = listMemories(input.db, {
    guildId: input.guildId,
    subjectUserId: input.currentUserId,
    includeGlobal: true,
  });
  return rows.find((row) =>
    row.subjectUserId === subjectUserId
    && row.kind === kind
    && row.content.trim().toLowerCase() === normalized
  ) ?? null;
}

/** Run background memory extraction and apply accepted updates. */
export async function extractAndApplyMemories(input: MemoryExtractionInput): Promise<void> {
  const complete = input.completeChat ?? completeLlmChat;
  const stable: StablePromptSection[] = [{
    role: "system",
    text: "You are a memory extraction routine. Return only JSON matching the schema.",
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

  for (const action of extracted.actions) {
    if (action.action === "none") continue;
    if (action.action === "delete") {
      if (editableMemory(input, action.id) === null) continue;
      deleteMemory(input.db, action.id);
      continue;
    }

    const existing = action.id !== undefined ? editableMemory(input, action.id) : null;
    if (action.id !== undefined && existing === null) continue;

    const subjectUserId = existing !== null
      ? existing.subjectUserId
      : action.subject === "current_user"
        ? input.currentUserId
        : null;
    const payload = {
      subjectUserId,
      kind: action.kind,
      content: action.content.trim(),
      sourceMessageId: input.sourceMessageId,
      confidence: action.confidence,
    };
    if (payload.content === "") continue;

    if (action.id !== undefined) {
      updateMemory(input.db, action.id, payload);
      continue;
    }

    if (duplicateMemory(input, subjectUserId, action.kind, payload.content) !== null) {
      continue;
    }

    createMemory(input.db, {
      guildId: input.guildId,
      ...payload,
    });
  }
}
