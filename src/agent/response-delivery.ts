import { createHash } from "node:crypto";
import type { Logger, RequestLog } from "../logger.ts";
import type { TtsResult } from "../tts/types.ts";
import { hasCompleteMessageAction, parseResponseDirectives, renderSegmentsForMemory, type MessageDelivery, type ResponseSegment } from "./response-directives.ts";
import type { AssetAttachmentResolver, HandlerDeps, MessageSender, OutboundAttachment, VoiceAttachment } from "./turn-types.ts";
import { assertActionCanCommit, isRecord, makeToolErrorText, sleepMs } from "./model-retry.ts";

export const DEFAULT_LIVE_MESSAGE_TYPING_HOLD_MS = 2000;

export type DispatchSegment =
  | { kind: "text"; text: string; delivery?: MessageDelivery }
  | {
    kind: "voice";
    text: string;
    voiceText: string;
    historyText: string;
    fallbackText: string;
    delivery?: MessageDelivery;
  };
class HandoffPersistenceError extends Error {
  constructor(cause: unknown) {
    super("Discord message was delivered, but its handoff could not be persisted.", { cause });
    this.name = "HandoffPersistenceError";
  }
}
function isDiscordSendPermissionError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === 50001 || error.code === 50013;
}
function assertSentMessageId(result: { sentMessageId: string }): void {
  if (result.sentMessageId === "") {
    throw new Error("Failed to send final Discord message: no sent message ID returned.");
  }
}
function joinNonEmpty(parts: string[]): string {
  return parts.filter((part) => part !== "").join("\n");
}

function renderSegmentsAsPlainText(segments: ResponseSegment[]): string {
  return joinNonEmpty(segments
    .filter((segment): segment is Extract<ResponseSegment, { kind: "text" | "voice" }> =>
      segment.kind === "text" || segment.kind === "voice"
    )
    .map((segment) => segment.text));
}

/**
 * Convert parsed directives into Discord sends. Text around a voice directive becomes
 * message content on the voice attachment, while only the voice body goes to TTS.
 */
function buildDispatchSegmentsForMessage(segments: Extract<ResponseSegment, { kind: "text" | "voice" }>[]): DispatchSegment[] {
  const dispatchSegments: DispatchSegment[] = [];
  const pendingText: Array<Extract<ResponseSegment, { kind: "text" }>> = [];

  for (const segment of segments) {
    if (segment.kind === "text") {
      pendingText.push(segment);
      continue;
    }

    const historySegments = [...pendingText, segment];
    dispatchSegments.push({
      kind: "voice",
      text: renderSegmentsAsPlainText(pendingText),
      voiceText: segment.text,
      historyText: renderSegmentsForMemory(historySegments),
      fallbackText: renderSegmentsAsPlainText(historySegments),
    });
    pendingText.length = 0;
  }

  if (pendingText.length > 0) {
    const text = renderSegmentsAsPlainText(pendingText);
    const trailingHistory = renderSegmentsForMemory(pendingText);
    const last = dispatchSegments[dispatchSegments.length - 1];
    if (last !== undefined && last.kind === "voice") {
      last.text = joinNonEmpty([last.text, text]);
      last.historyText = joinNonEmpty([last.historyText, trailingHistory]);
      last.fallbackText = joinNonEmpty([last.fallbackText, text]);
      return dispatchSegments;
    }
    dispatchSegments.push({ kind: "text", text });
  }

  return dispatchSegments;
}

function buildDispatchSegments(segments: ResponseSegment[]): DispatchSegment[] {
  const dispatchSegments: DispatchSegment[] = [];
  let currentMessage: Extract<ResponseSegment, { kind: "text" | "voice" }>[] = [];
  let currentDelivery: MessageDelivery | undefined;

  for (const segment of segments) {
    if (segment.kind === "text" || segment.kind === "voice") {
      currentMessage.push(segment);
      continue;
    }

    if (segment.kind === "emptyMessage") {
      const messageSegments = buildDispatchSegmentsForMessage(currentMessage);
      if (messageSegments[0] !== undefined && currentDelivery !== undefined) {
        messageSegments[0].delivery = currentDelivery;
      }
      dispatchSegments.push(...messageSegments);
      dispatchSegments.push({ kind: "text", text: "", delivery: segment.delivery });
      currentMessage = [];
      currentDelivery = undefined;
      continue;
    }

    const messageSegments = buildDispatchSegmentsForMessage(currentMessage);
    if (messageSegments[0] !== undefined && currentDelivery !== undefined) {
      messageSegments[0].delivery = currentDelivery;
    }
    dispatchSegments.push(...messageSegments);
    currentMessage = [];
    currentDelivery = segment.delivery;
  }

  const messageSegments = buildDispatchSegmentsForMessage(currentMessage);
  if (messageSegments[0] !== undefined && currentDelivery !== undefined) {
    messageSegments[0].delivery = currentDelivery;
  }
  dispatchSegments.push(...messageSegments);
  return dispatchSegments;
}

function effectiveReply(input: {
  delivery?: MessageDelivery;
  defaultReply: boolean;
  destinationChannelId?: string;
  currentChannelId?: string;
}): boolean {
  if (input.delivery?.replyTo !== undefined) return false;
  if (input.delivery?.reply !== undefined) return input.delivery.reply;
  if (input.destinationChannelId === undefined || input.destinationChannelId === input.currentChannelId) {
    return input.defaultReply;
  }
  return false;
}

function isCurrentChannelDestination(destinationChannelId: string | undefined, currentChannelId: string | undefined): boolean {
  return destinationChannelId === undefined || (
    currentChannelId !== undefined && destinationChannelId === currentChannelId
  );
}

/** Builds a stable key for one logical Discord send so transport retries can be idempotent. */
function discordSendDedupeKey(input: { requestLog?: RequestLog; sendId: string }): string {
  const requestScope = input.requestLog?.requestId ?? `${Date.now()}:${Math.random()}`;
  return createHash("sha256")
    .update(`${requestScope}:${input.sendId}`)
    .digest("base64url");
}

async function sendOneSegment(input: {
  sender: MessageSender;
  generateSpeech?: (text: string) => Promise<TtsResult>;
  ttsEnabled: boolean;
  segment: DispatchSegment;
  sendId: string;
  reply: boolean;
  destinationChannelId?: string;
  currentChannelId?: string;
  attachments?: OutboundAttachment[];
  requestLog?: RequestLog;
  signal?: AbortSignal;
  onSent?: () => void | Promise<void>;
  onHandoffDelivered?: HandlerDeps["onHandoffDelivered"];
}): Promise<void> {
  const destinationChannelId = input.segment.delivery?.channelId ?? input.destinationChannelId;
  const args: Record<string, unknown> = {
    text: input.segment.text,
    reply: effectiveReply({
      delivery: input.segment.delivery,
      defaultReply: input.reply,
      destinationChannelId,
      currentChannelId: input.currentChannelId,
    }),
    ...(input.segment.delivery?.replyTo !== undefined ? { reply_to_message_id: input.segment.delivery.replyTo } : {}),
    ...(destinationChannelId !== undefined ? { channel_id: destinationChannelId } : {}),
    ...(input.attachments !== undefined && input.attachments.length > 0
      ? { attachments: input.attachments.map((attachment) => attachment.filename) }
      : {}),
  };
  const toolName = input.segment.kind === "voice" ? "send_voice" : "send_text";
  if (input.segment.kind === "voice") {
    args.voice_text = input.segment.voiceText;
    args.history_text = input.segment.historyText;
  }
  input.requestLog?.recordToolStart(input.sendId, toolName, args);
  try {
    let voice: VoiceAttachment | undefined;
    if (input.segment.kind === "voice") {
      if (!input.ttsEnabled) {
        throw new Error("Voice messages are not enabled for this server.");
      }
      if (input.generateSpeech === undefined) {
        throw new Error("Voice generation unavailable.");
      }
      const ttsResult = await input.generateSpeech(input.segment.voiceText);
      if (!ttsResult.ok) {
        throw new Error(ttsResult.error);
      }
      voice = {
        buffer: ttsResult.buffer,
        filename: "voice_message.mp3",
        contentType: ttsResult.contentType,
        historyText: input.segment.historyText,
      };
    }

    const result = await input.sender(
      input.segment.text,
      effectiveReply({
        delivery: input.segment.delivery,
        defaultReply: input.reply,
        destinationChannelId,
        currentChannelId: input.currentChannelId,
      }),
      destinationChannelId,
      voice,
      input.signal,
      input.segment.delivery?.replyTo,
      input.attachments,
      discordSendDedupeKey({ requestLog: input.requestLog, sendId: input.sendId }),
    );
    assertSentMessageId(result);
    if (input.segment.delivery?.handoff !== undefined && input.onHandoffDelivered !== undefined) {
      if (result.sentGuildId === undefined || result.sentChannelId === undefined) {
        throw new HandoffPersistenceError(
          new Error("Discord sender did not return destination identifiers for a handoff."),
        );
      }
      try {
        await input.onHandoffDelivered({
          handoff: input.segment.delivery.handoff,
          routedMessageId: result.sentMessageId,
          destinationGuildId: result.sentGuildId,
          destinationChannelId: result.sentChannelId,
        });
      } catch (error) {
        throw new HandoffPersistenceError(error);
      }
    }
    await input.onSent?.();
    const warnings = result.warnings ?? [];
    input.requestLog?.recordToolEnd(input.sendId, false, {
      content: [{
        type: "text",
        text: warnings.length > 0
          ? `Message sent.\nWarning: unknown emotes: ${warnings.join(", ")}`
          : "Message sent.",
      }],
      details: {
        sentMessageId: result.sentMessageId,
        ...(voice !== undefined ? { voiceGenerated: true } : {}),
        ...(input.attachments !== undefined && input.attachments.length > 0
          ? { attachments: input.attachments.map((attachment) => attachment.filename) }
          : {}),
        ...(warnings.length > 0 ? { unresolvedEmotes: warnings } : {}),
      },
    });
  } catch (error) {
    const errorText = makeToolErrorText(error);
    input.requestLog?.recordToolEnd(input.sendId, true, {
      content: [{ type: "text", text: errorText }],
    });
    if (isDiscordSendPermissionError(error)) return;
    throw error;
  }
}

export async function sendResponseSegments(input: {
  sender: MessageSender;
  generateSpeech?: (text: string) => Promise<TtsResult>;
  ttsEnabled: boolean;
  segments: ResponseSegment[];
  replyFirst: boolean;
  sentOffset?: number;
  destinationChannelId?: string;
  currentChannelId?: string;
  requestLog?: RequestLog;
  log?: Logger;
  onStillWorking?: (channelId: string | undefined) => void | Promise<void>;
  getTypingStartedAt?: () => number;
  onVisibleOutput?: () => void;
  onSegmentSent?: (sent: { segment: DispatchSegment; hasMoreSegments: boolean }) => void | Promise<void>;
  currentChannelOutputAlreadySent?: boolean;
  onCurrentChannelOutput?: () => void;
  sendIdPrefix?: string;
  typingHoldMs?: number;
  typingHoldMsForSegment?: (segment: DispatchSegment) => number;
  signal?: AbortSignal;
  pendingAttachments?: OutboundAttachment[];
  resolveAssetAttachments?: AssetAttachmentResolver;
  onHandoffDelivered?: HandlerDeps["onHandoffDelivered"];
}): Promise<number> {
  let sent = input.sentOffset ?? 0;
  let sentNow = 0;
  let currentChannelOutputSent = input.currentChannelOutputAlreadySent === true;
  const dispatchSegments = buildDispatchSegments(input.segments);
  for (const segment of dispatchSegments) {
    sent += 1;
    sentNow += 1;
    const hasMoreSegments = sentNow < dispatchSegments.length;
    const segmentDestinationChannelId = segment.delivery?.channelId ?? input.destinationChannelId;
    const currentChannelDestination = isCurrentChannelDestination(segmentDestinationChannelId, input.currentChannelId);
    const useDefaultReply = input.replyFirst && currentChannelDestination && !currentChannelOutputSent;
    const pendingAttachments = input.pendingAttachments !== undefined && input.pendingAttachments.length > 0
      ? input.pendingAttachments.splice(0)
      : undefined;
    const referencedIds = segment.delivery?.assetIds;
    const referencedAttachments = referencedIds !== undefined && referencedIds.length > 0
      ? (await input.resolveAssetAttachments?.(referencedIds)) ?? []
      : [];
    const attachments = [
      ...(pendingAttachments ?? []),
      ...referencedAttachments,
    ];
    if (segment.kind === "text" && segment.text === "" && attachments.length === 0) {
      throw new Error("Cannot send <message>: it has no text and no referenced asset resolved.");
    }
    const sendId = `${input.sendIdPrefix ?? "final-send"}-${sent}`;
    const ensureTypingHoldBeforeSend = async (): Promise<void> => {
      const typingHoldMs = input.typingHoldMsForSegment?.(segment) ?? 0;
      if (typingHoldMs <= 0) return;
      let typingStartedAt = input.getTypingStartedAt?.() ?? 0;
      if (typingStartedAt <= 0) {
        await input.onStillWorking?.(segmentDestinationChannelId);
        typingStartedAt = input.getTypingStartedAt?.() ?? 0;
      }
      const elapsedTypingMs = typingStartedAt > 0 ? Date.now() - typingStartedAt : 0;
      await sleepMs(typingHoldMs - Math.max(0, elapsedTypingMs), input.signal);
    };
    const onSent = async (): Promise<void> => {
      input.onVisibleOutput?.();
      if (currentChannelDestination && !currentChannelOutputSent) {
        currentChannelOutputSent = true;
        input.onCurrentChannelOutput?.();
      }
      await input.onSegmentSent?.({ segment, hasMoreSegments });
      if (
        segment.delivery?.keepTyping === true
        && hasMoreSegments
        && input.typingHoldMsForSegment === undefined
      ) {
        await input.onStillWorking?.(segmentDestinationChannelId);
        await sleepMs(input.typingHoldMs ?? 0, input.signal);
      }
    };
    if (segment.kind === "text") {
      await ensureTypingHoldBeforeSend();
      await sendOneSegment({
        sender: input.sender,
        generateSpeech: input.generateSpeech,
        ttsEnabled: input.ttsEnabled,
        segment,
        sendId,
        reply: useDefaultReply,
        destinationChannelId: segmentDestinationChannelId,
        currentChannelId: input.currentChannelId,
        attachments: attachments.length > 0 ? attachments : undefined,
        requestLog: input.requestLog,
        signal: input.signal,
        onSent,
        onHandoffDelivered: input.onHandoffDelivered,
      });
      continue;
    }

    try {
      await ensureTypingHoldBeforeSend();
      await sendOneSegment({
        sender: input.sender,
        generateSpeech: input.generateSpeech,
        ttsEnabled: input.ttsEnabled,
        segment,
        sendId,
        reply: useDefaultReply,
        destinationChannelId: segmentDestinationChannelId,
        currentChannelId: input.currentChannelId,
        attachments: attachments.length > 0 ? attachments : undefined,
        requestLog: input.requestLog,
        signal: input.signal,
        onSent,
        onHandoffDelivered: input.onHandoffDelivered,
      });
    } catch (error) {
      if (error instanceof HandoffPersistenceError) throw error;
      input.log?.warn("voice directive failed; falling back to text", {
        error: makeToolErrorText(error),
      });
      await ensureTypingHoldBeforeSend();
      await sendOneSegment({
        sender: input.sender,
        generateSpeech: input.generateSpeech,
        ttsEnabled: input.ttsEnabled,
        segment: { kind: "text", text: segment.fallbackText, delivery: segment.delivery },
        sendId: `${sendId}-fallback`,
        reply: useDefaultReply,
        destinationChannelId: segmentDestinationChannelId,
        currentChannelId: input.currentChannelId,
        attachments: attachments.length > 0 ? attachments : undefined,
        requestLog: input.requestLog,
        signal: input.signal,
        onSent,
        onHandoffDelivered: input.onHandoffDelivered,
      });
    }
  }
  return sentNow;
}

interface LiveMessageDispatchDeps {
  sender: MessageSender;
  generateSpeech?: (text: string) => Promise<TtsResult>;
  ttsEnabled: boolean;
  replyFirst: boolean;
  destinationChannelId?: string;
  currentChannelId?: string;
  requestLog?: RequestLog;
  log?: Logger;
  onStillWorking?: (channelId: string | undefined) => void | Promise<void>;
  getTypingStartedAt?: () => number;
  onVisibleOutput?: () => void;
  onActionCommitted?: () => void;
  typingHoldMs: number;
  typingHoldMsForSegment?: (segment: DispatchSegment) => number;
  signal?: AbortSignal;
  pendingAttachments?: OutboundAttachment[];
  resolveAssetAttachments?: AssetAttachmentResolver;
  onHandoffDelivered?: HandlerDeps["onHandoffDelivered"];
}

export class LiveMessageDispatcher {
  private readonly deps: LiveMessageDispatchDeps;
  private buffer = "";
  private consumedUntil = 0;
  private sent = 0;
  private currentChannelOutputSent = false;
  private disabled = false;
  private actionCommitted = false;
  private gapTypingSent = false;
  private gapTypingReadyAt = 0;

  constructor(deps: LiveMessageDispatchDeps) {
    this.deps = deps;
  }

  sentCount(): number {
    return this.sent;
  }

  /**
   * Start a fresh provider stream while preserving how many Discord messages
   * earlier model turns already emitted in this agent loop.
   */
  startModelTurn(): void {
    this.buffer = "";
    this.consumedUntil = 0;
    this.disabled = false;
    this.clearGapTyping();
  }

  async push(delta: string): Promise<void> {
    if (delta === "" || this.disabled) return;
    this.buffer += delta;
    if (!this.actionCommitted && hasCompleteMessageAction(this.buffer)) this.commitAction();
    await this.flushCompleteEnvelopes({ notifyTyping: true });
  }

  async finish(finalText: string): Promise<number> {
    if (this.disabled || this.sent === 0) return this.sent;
    const consumedPrefix = this.buffer.slice(0, this.consumedUntil);
    if (!finalText.startsWith(consumedPrefix)) {
      const parsed = parseResponseDirectives(finalText);
      if (!parsed.ignored && parsed.segments.length > 0) {
        this.commitAction();
        this.sent += await sendResponseSegments({
          ...this.deps,
          segments: parsed.segments,
          sentOffset: this.sent,
          replyFirst: this.deps.replyFirst,
          currentChannelOutputAlreadySent: this.currentChannelOutputSent,
          onCurrentChannelOutput: () => { this.currentChannelOutputSent = true; },
          onStillWorking: this.deps.typingHoldMsForSegment === undefined ? undefined : this.deps.onStillWorking,
        });
      }
      return this.sent;
    }
    this.buffer = finalText;
    await this.flushCompleteEnvelopes({ notifyTyping: false });
    const remainder = this.buffer.slice(this.consumedUntil).trim();
    if (remainder !== "") {
      const parsed = parseResponseDirectives(remainder);
      if (!parsed.ignored && parsed.segments.length > 0) {
        this.commitAction();
        this.sent += await sendResponseSegments({
          ...this.deps,
          segments: parsed.segments,
          sentOffset: this.sent,
          replyFirst: this.deps.replyFirst,
          currentChannelOutputAlreadySent: this.currentChannelOutputSent,
          onCurrentChannelOutput: () => { this.currentChannelOutputSent = true; },
          onStillWorking: this.deps.typingHoldMsForSegment === undefined ? undefined : this.deps.onStillWorking,
        });
      }
      this.consumedUntil = this.buffer.length;
    }
    return this.sent;
  }

  private async flushCompleteEnvelopes(input: { notifyTyping: boolean }): Promise<void> {
    for (;;) {
      const cursor = this.skipWhitespace(this.consumedUntil);
      if (this.buffer.slice(cursor).toLowerCase().startsWith("<ignore")) {
        if (this.sent > 0) {
          const ignoredEnd = this.completeIgnoreDirectiveEnd(cursor);
          if (ignoredEnd === null) return;
          this.consumedUntil = ignoredEnd;
          continue;
        }
        this.disabled = true;
        return;
      }
      if (!this.buffer.slice(cursor).toLowerCase().startsWith("<message")) {
        return;
      }

      const tagEnd = this.buffer.indexOf(">", cursor);
      if (tagEnd === -1) return;

      const closeStart = this.buffer.toLowerCase().indexOf("</message>", tagEnd + 1);
      if (closeStart === -1) {
        if (input.notifyTyping && this.sent > 0) {
          await this.notifyTypingForGap();
        }
        return;
      }

      const closeEnd = closeStart + "</message>".length;
      const rawEnvelope = this.buffer.slice(cursor, closeEnd);
      const parsed = parseResponseDirectives(rawEnvelope);
      if (!parsed.ignored && parsed.segments.length > 0) {
        this.commitAction();
        if (this.deps.typingHoldMsForSegment === undefined) await this.waitForGapTypingHold();
        this.clearGapTyping();
        const typeAfterMessage = input.notifyTyping
          && (messageWantsTyping(parsed.segments) || this.nextMessageHasStarted(closeEnd));
        this.sent += await sendResponseSegments({
          ...this.deps,
          segments: parsed.segments,
          sentOffset: this.sent,
          replyFirst: this.deps.replyFirst,
          currentChannelOutputAlreadySent: this.currentChannelOutputSent,
          onCurrentChannelOutput: () => { this.currentChannelOutputSent = true; },
          onStillWorking: this.deps.typingHoldMsForSegment === undefined ? undefined : this.deps.onStillWorking,
          onSegmentSent: async ({ hasMoreSegments }) => {
            if (!hasMoreSegments && typeAfterMessage) await this.notifyTypingForGap();
          },
        });
      }
      this.consumedUntil = closeEnd;
    }
  }

  private async notifyTypingForGap(): Promise<void> {
    if (this.gapTypingSent) return;
    this.gapTypingSent = true;
    await this.deps.onStillWorking?.(this.deps.destinationChannelId);
    this.gapTypingReadyAt = Date.now() + this.deps.typingHoldMs;
  }

  private commitAction(): void {
    if (this.actionCommitted) return;
    assertActionCanCommit(this.deps.signal, "Agent loop aborted before message delivery.");
    this.actionCommitted = true;
    this.deps.onActionCommitted?.();
  }

  private async waitForGapTypingHold(): Promise<void> {
    if (!this.gapTypingSent) return;
    await sleepMs(this.gapTypingReadyAt - Date.now(), this.deps.signal);
  }

  private clearGapTyping(): void {
    this.gapTypingSent = false;
    this.gapTypingReadyAt = 0;
  }

  private nextMessageHasStarted(index: number): boolean {
    const cursor = this.skipWhitespace(index);
    return this.buffer.slice(cursor).toLowerCase().startsWith("<message");
  }

  private skipWhitespace(index: number): number {
    let cursor = index;
    while (cursor < this.buffer.length && /\s/.test(this.buffer[cursor] ?? "")) {
      cursor += 1;
    }
    return cursor;
  }

  private completeIgnoreDirectiveEnd(index: number): number | null {
    const tagEnd = this.buffer.indexOf(">", index);
    if (tagEnd === -1) return null;
    const rawTag = this.buffer.slice(index, tagEnd + 1);
    if (/\/\s*>$/.test(rawTag)) return tagEnd + 1;
    const closeStart = this.buffer.toLowerCase().indexOf("</ignore>", tagEnd + 1);
    return closeStart === -1 ? null : closeStart + "</ignore>".length;
  }
}

function messageWantsTyping(segments: ResponseSegment[]): boolean {
  for (const segment of segments) {
    if (segment.kind === "messageBreak" && segment.delivery?.keepTyping === true) return true;
  }
  return false;
}
