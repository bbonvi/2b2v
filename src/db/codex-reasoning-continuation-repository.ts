import type { Database } from "./database";
import type { ProviderNativeAssistantContent } from "../llm/types";

export interface CodexReasoningContinuationKey {
  guildId: string;
  channelId: string;
  userId: string;
  provider: string;
  model: string;
  sessionId?: string;
}

export interface CodexReasoningContinuationRow extends CodexReasoningContinuationKey {
  sourceMessageId?: string;
  providerNativeContent: ProviderNativeAssistantContent[];
  createdAt: number;
}

function sessionIdForDb(sessionId: string | undefined): string {
  return sessionId ?? "";
}

function validProviderNativeContent(value: unknown): value is ProviderNativeAssistantContent[] {
  if (!Array.isArray(value)) return false;
  return value.every((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const type = (item as { type?: unknown }).type;
    return type === "thinking" || type === "text" || type === "toolCall";
  });
}

/** Store the latest opaque Codex native continuation for one user/channel/model session. */
export function upsertCodexReasoningContinuation(
  db: Database,
  input: CodexReasoningContinuationKey & {
    sourceMessageId?: string;
    providerNativeContent: ProviderNativeAssistantContent[];
    createdAt?: number;
  },
): void {
  if (input.providerNativeContent.length === 0) return;
  const createdAt = input.createdAt ?? Date.now();
  db.raw.prepare(
    `INSERT INTO codex_reasoning_continuations
       (guild_id, channel_id, user_id, provider, model, session_id, source_message_id, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, channel_id, user_id, provider, model, session_id)
     DO UPDATE SET
       source_message_id = excluded.source_message_id,
       payload_json = excluded.payload_json,
       created_at = excluded.created_at`,
  ).run(
    input.guildId,
    input.channelId,
    input.userId,
    input.provider,
    input.model,
    sessionIdForDb(input.sessionId),
    input.sourceMessageId ?? null,
    JSON.stringify(input.providerNativeContent),
    createdAt,
  );
}

/** Load the latest non-stale Codex native continuation for one user/channel/model session. */
export function getCodexReasoningContinuation(
  db: Database,
  input: CodexReasoningContinuationKey & { maxAgeMs: number; now?: number },
): CodexReasoningContinuationRow | null {
  const minCreatedAt = (input.now ?? Date.now()) - input.maxAgeMs;
  const row = db.raw.prepare(
    `SELECT source_message_id, payload_json, created_at
       FROM codex_reasoning_continuations
      WHERE guild_id = ?
        AND channel_id = ?
        AND user_id = ?
        AND provider = ?
        AND model = ?
        AND session_id = ?
        AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 1`,
  ).get(
    input.guildId,
    input.channelId,
    input.userId,
    input.provider,
    input.model,
    sessionIdForDb(input.sessionId),
    minCreatedAt,
  ) as { source_message_id: string | null; payload_json: string; created_at: number } | null;

  if (row === null) return null;
  const parsed = JSON.parse(row.payload_json) as unknown;
  if (!validProviderNativeContent(parsed)) return null;
  return {
    guildId: input.guildId,
    channelId: input.channelId,
    userId: input.userId,
    provider: input.provider,
    model: input.model,
    sessionId: input.sessionId,
    ...(row.source_message_id !== null ? { sourceMessageId: row.source_message_id } : {}),
    providerNativeContent: parsed,
    createdAt: row.created_at,
  };
}

/** Remove stale continuation rows. */
export function deleteExpiredCodexReasoningContinuations(db: Database, olderThanMs: number, now = Date.now()): number {
  const result = db.raw.prepare("DELETE FROM codex_reasoning_continuations WHERE created_at < ?").run(now - olderThanMs);
  return result.changes;
}
