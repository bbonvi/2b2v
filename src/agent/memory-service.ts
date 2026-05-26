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
import { completeOpenRouterChat, type OpenRouterChatRequest } from "../llm/openrouter-chat";
import type { PromptCachingConfig } from "../config/types";
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
    id: Type.Optional(Type.Integer()),
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
    id: Type.Integer(),
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

function parseExtraction(rawText: string): MemoryExtraction | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
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
                    id: { type: "integer" },
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
                    id: { type: "integer" },
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
    "Save stable user preferences, long-term facts, recurring project context, relationships, and explicit corrections.",
    "Do not save jokes, transient moods, ordinary chat, or one-off requests.",
    "Prefer updating an existing memory id over creating duplicates.",
    "Use subject=current_user for facts about the triggering user; use subject=global for shared server/project context.",
    "",
    "Existing memories:",
    current !== "" ? current : "(none)",
    "",
    "Recent context:",
    input.recentContext !== "" ? input.recentContext : "(none)",
    "",
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

/** Run background memory extraction and apply accepted updates. */
export async function extractAndApplyMemories(input: MemoryExtractionInput): Promise<void> {
  const complete = input.completeChat ?? completeOpenRouterChat;
  const stable: StablePromptSection[] = [{
    role: "system",
    text: "You are a memory extraction routine. Return only JSON matching the schema.",
  }];
  const result = await complete({
    apiKey: input.apiKey,
    model: input.model,
    systemPrompt: "",
    messages: [{ role: "user", content: buildExtractionPrompt(input) }],
    providerParams: input.providerParams,
    responseFormat: memoryExtractionResponseFormat(),
    signal: input.signal,
    onPayload: (payload) => {
      prependStableSectionsToPayload(payload, stable, input.promptCaching);
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

    createMemory(input.db, {
      guildId: input.guildId,
      ...payload,
    });
  }
}
