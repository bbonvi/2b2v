import { parseAssetRef, type AssetRef } from "./asset-id.ts";

export type ResponseSegment =
  | { kind: "text"; text: string }
  | { kind: "voice"; text: string }
  | { kind: "messageBreak"; delivery?: MessageDelivery }
  | { kind: "emptyMessage"; delivery: MessageDelivery };

export interface MessageDelivery {
  channelId?: string;
  reply?: boolean;
  replyTo?: string;
  keepTyping?: boolean;
  assetIds?: AssetRef[];
}

export interface ParsedResponseDirectives {
  ignored: boolean;
  ignoredText?: string;
  /** Authored private monologue removed from every user-visible transport. */
  privateThoughts?: string[];
  malformedPrivateOutput?: boolean;
  segments: ResponseSegment[];
}

type SegmentMode =
  | { kind: "text" }
  | { kind: "voice" };

interface ParseResult {
  ignored: boolean;
  ignoredText?: string;
  segments: ResponseSegment[];
  index: number;
  closed: boolean;
}

const RESERVED_TAG_RE = /<\s*\/?\s*(?:voice|audio|message|ignore)(?=[\s/>])/i;
const FENCE_RE = /```[ \t]*(?:[a-zA-Z0-9_-]+)?[ \t]*\n?([\s\S]*?)```/g;
const PRIVATE_TAG_RE = /<\s*(\/?)\s*(scene|thoughts?)(?=[\s/>])([^>]*)>/gi;
const PRIVATE_TAG_PREFIX_RE = /<\s*\/?\s*(?:scene|thoughts?)(?=[\s/>]|$)/i;
const TAG_RE = /<\s*(\/?)\s*(voice|audio|message|ignore)(?=[\s/>])([^>]*)>/gi;
const USERNAME_PATTERN = "[A-Za-z0-9_](?:[A-Za-z0-9_.]{0,30}[A-Za-z0-9_])?";
const CHANNEL_PATTERN = "#[A-Za-z0-9_][\\w-]{0,99}";
const URL_PATTERN = "https?:\\/\\/[^\\s<>()]+";
const VOICE_EXTERNAL_TEXT_RE = new RegExp(
  `(^|[\\s([{])(<@!?\\d+>|<#\\d+>|@(?!everyone\\b|here\\b)(?:<${USERNAME_PATTERN}>|${USERNAME_PATTERN})|${CHANNEL_PATTERN}|${URL_PATTERN})([,;:.!?]?)(?=$|[\\s)\\]}])`,
  "gi",
);

function unwrapDirectiveFences(text: string): string {
  return text.replace(FENCE_RE, (match: string, inner: string) =>
    RESERVED_TAG_RE.test(inner) ? inner : match
  );
}

function stripPrivateBlocks(text: string): {
  text: string;
  thoughts: string[];
  malformed: boolean;
} {
  const visible: string[] = [];
  const thoughts: string[] = [];
  const tagRe = new RegExp(PRIVATE_TAG_RE.source, "gi");
  let cursor = 0;
  let active: { tag: "scene" | "thought" | "thoughts"; bodyStart: number } | undefined;

  for (;;) {
    const match = tagRe.exec(text);
    if (match === null) break;
    const closing = match[1] === "/";
    const rawTag = match[2];
    if (rawTag === undefined) continue;
    const tag = rawTag.toLowerCase() as "scene" | "thought" | "thoughts";
    const attrs = match[3] ?? "";
    const selfClosing = /\/\s*$/.test(attrs);

    if (active === undefined) {
      if (closing) return { text: "", thoughts: [], malformed: true };
      visible.push(text.slice(cursor, match.index));
      if (selfClosing) {
        cursor = tagRe.lastIndex;
        continue;
      }
      active = { tag, bodyStart: tagRe.lastIndex };
      continue;
    }

    if (!closing || tag !== active.tag || selfClosing) {
      return { text: "", thoughts: [], malformed: true };
    }
    if (active.tag === "thought" || active.tag === "thoughts") {
      const body = text.slice(active.bodyStart, match.index).trim();
      if (body !== "") thoughts.push(body);
    }
    cursor = tagRe.lastIndex;
    active = undefined;
  }

  if (active !== undefined) return { text: "", thoughts: [], malformed: true };
  visible.push(text.slice(cursor));
  const stripped = visible.join("").trim();
  return {
    text: stripped,
    thoughts,
    malformed: PRIVATE_TAG_PREFIX_RE.test(stripped),
  };
}

function pushTextSegment(segments: ResponseSegment[], rawText: string): void {
  const text = rawText.trim();
  if (text === "") return;
  const previous = segments[segments.length - 1];
  if (previous !== undefined && previous.kind === "text") {
    previous.text = `${previous.text}\n${text}`;
    return;
  }
  segments.push({ kind: "text", text });
}

function pushVoiceSegment(segments: ResponseSegment[], rawText: string): void {
  const text = sanitizeVoiceText(rawText);
  if (text === "") return;
  segments.push({ kind: "voice", text });
}

function pushMessageBreak(segments: ResponseSegment[], delivery?: MessageDelivery): void {
  const previous = segments[segments.length - 1];
  if (previous !== undefined && previous.kind === "messageBreak") {
    if (delivery !== undefined) previous.delivery = delivery;
    return;
  }
  if (previous === undefined && delivery === undefined) return;
  segments.push({ kind: "messageBreak", ...(delivery !== undefined ? { delivery } : {}) });
}

function pushEmptyMessage(segments: ResponseSegment[], delivery: MessageDelivery): void {
  segments.push({ kind: "emptyMessage", delivery });
}

/** Split Discord-only tokens out of voice text so pings/channels are sent as message content, not spoken. */
function pushVoiceTextSegments(segments: ResponseSegment[], rawText: string): void {
  let cursor = 0;
  const tokenRe = new RegExp(VOICE_EXTERNAL_TEXT_RE.source, "gi");
  for (;;) {
    const match = tokenRe.exec(rawText);
    if (match === null) break;

    const prefix = match[1] ?? "";
    const token = match[2];
    if (token === undefined) continue;

    const tokenStart = match.index + prefix.length;
    const punctuation = match[3] ?? "";
    pushVoiceSegment(segments, rawText.slice(cursor, tokenStart));
    pushTextSegment(segments, token);
    cursor = tokenStart + token.length + punctuation.length;
  }
  pushVoiceSegment(segments, rawText.slice(cursor));
}

function pushSegment(
  segments: ResponseSegment[],
  mode: SegmentMode,
  rawText: string,
): void {
  if (mode.kind === "voice") {
    pushVoiceTextSegments(segments, rawText);
    return;
  }
  pushTextSegment(segments, rawText);
}

function unescapeAttributeValue(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseMessageDelivery(attrs: string): MessageDelivery | undefined {
  const delivery: MessageDelivery = {};
  const attrRe = /\s(channel_id|reply|reply_to|keep_typing)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+))/gi;
  for (;;) {
    const match = attrRe.exec(attrs);
    if (match === null) break;
    const rawName = match[1];
    if (rawName === undefined) continue;
    const value = unescapeAttributeValue(match[2] ?? match[3] ?? match[4] ?? "").trim();
    if (rawName.toLowerCase() === "channel_id") {
      if (value !== "") delivery.channelId = value;
    } else if (rawName.toLowerCase() === "reply") {
      if (value.toLowerCase() === "true") delivery.reply = true;
      if (value.toLowerCase() === "false") delivery.reply = false;
    } else if (rawName.toLowerCase() === "keep_typing") {
      if (value.toLowerCase() === "true") delivery.keepTyping = true;
      if (value.toLowerCase() === "false") delivery.keepTyping = false;
    } else if (value !== "") {
      delivery.replyTo = value;
    }
  }
  const assetIds = parseAssetIdsAttribute(attrs);
  if (assetIds !== undefined && assetIds.length > 0) delivery.assetIds = assetIds;
  return delivery.channelId !== undefined
    || delivery.reply !== undefined
    || delivery.replyTo !== undefined
    || delivery.keepTyping !== undefined
    || delivery.assetIds !== undefined
    ? delivery
    : undefined;
}

function parseAssetIdsAttribute(attrs: string): AssetRef[] | undefined {
  const match = /\sasset_ids\s*=\s*(?:"([^"]*)"|'([^']*)'|(\[[^\]]*\]))/i.exec(attrs);
  if (match === null) return undefined;
  const raw = unescapeAttributeValue(match[1] ?? match[2] ?? match[3] ?? "").trim();
  if (!raw.startsWith("[") || !raw.endsWith("]")) return undefined;
  const inner = raw.slice(1, -1).trim();
  if (inner === "") return [];
  const ids = inner.split(",").map((part) => parseAssetRef(part.trim()));
  return ids.every((id) => id !== null) ? ids : undefined;
}

function renderIgnoredText(rawText: string): string {
  const text = rawText.trim();
  return `<ignore>${text}</ignore>`;
}

function ignoreDirectiveEnd(text: string, tagEnd: number): number {
  const closeStart = text.toLowerCase().indexOf("</ignore>", tagEnd);
  return closeStart === -1 ? text.length : closeStart + "</ignore>".length;
}

function closingTagEnd(text: string, tag: "voice" | "audio" | "message", from: number): number {
  const closeStart = text.toLowerCase().indexOf(`</${tag}>`, from);
  return closeStart === -1 ? from : closeStart + tag.length + 3;
}

function hasOutputSegment(segments: ResponseSegment[]): boolean {
  return segments.some((segment) => segment.kind !== "messageBreak");
}

export function sanitizeVoiceText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.:;!?])/g, "$1")
    .trim();
}

function parseRange(
  text: string,
  start: number,
  mode: SegmentMode,
  stopTag: "voice" | "audio" | "message" | "ignore" | null,
): ParseResult {
  const segments: ResponseSegment[] = [];
  let cursor = start;
  const tagRe = new RegExp(TAG_RE.source, "gi");
  tagRe.lastIndex = start;

  for (;;) {
    const match = tagRe.exec(text);
    if (match === null) break;

    const tagStart = match.index;
    const tagEnd = tagRe.lastIndex;
    const isClosing = match[1] === "/";
    const rawTag = match[2];
    if (rawTag === undefined) continue;
    const tag = rawTag.toLowerCase() as "voice" | "audio" | "message" | "ignore";
    const attrs = match[3] ?? "";
    const selfClosing = /\/\s*$/.test(attrs);

    pushSegment(segments, mode, text.slice(cursor, tagStart));

    if (isClosing) {
      if (stopTag === tag) {
        return { ignored: false, segments, index: tagEnd, closed: true };
      }
      pushSegment(segments, mode, match[0]);
      cursor = tagEnd;
      continue;
    }

    if (tag === "ignore") {
      if (hasOutputSegment(segments)) {
        cursor = selfClosing ? tagEnd : ignoreDirectiveEnd(text, tagEnd);
        tagRe.lastIndex = cursor;
        continue;
      }
      if (selfClosing) {
        return { ignored: true, ignoredText: renderIgnoredText(""), segments, index: tagEnd, closed: true };
      }
      const closeStart = text.toLowerCase().indexOf("</ignore>", tagEnd);
      if (closeStart === -1) {
        return { ignored: true, ignoredText: renderIgnoredText(text.slice(tagEnd)), segments, index: text.length, closed: false };
      }
      const closeEnd = closeStart + "</ignore>".length;
      return { ignored: true, ignoredText: renderIgnoredText(text.slice(tagEnd, closeStart)), segments, index: closeEnd, closed: true };
    }

    if (selfClosing) {
      cursor = tagEnd;
      continue;
    }

    if (tag === "message") {
      const delivery = parseMessageDelivery(attrs);
      const nested = parseRange(text, tagEnd, { kind: "text" }, "message");
      if (nested.ignored) {
        if (hasOutputSegment(segments)) {
          cursor = closingTagEnd(text, "message", nested.index);
          tagRe.lastIndex = cursor;
          continue;
        }
        return { ignored: true, ignoredText: nested.ignoredText, segments, index: text.length, closed: false };
      }
      if (hasOutputSegment(nested.segments)) {
        pushMessageBreak(segments, delivery);
        segments.push(...nested.segments);
        pushMessageBreak(segments);
      } else if (delivery !== undefined) {
        pushEmptyMessage(segments, delivery);
      }
      cursor = nested.index;
      tagRe.lastIndex = cursor;
      continue;
    }

    const nested = parseRange(text, tagEnd, { kind: "voice" }, tag);
    segments.push(...nested.segments);
    if (nested.ignored) {
      if (hasOutputSegment(segments)) {
        cursor = closingTagEnd(text, tag, nested.index);
        tagRe.lastIndex = cursor;
        continue;
      }
      return { ignored: true, ignoredText: nested.ignoredText, segments, index: text.length, closed: false };
    }
    cursor = nested.index;
    tagRe.lastIndex = cursor;
  }

  pushSegment(segments, mode, text.slice(cursor));
  return { ignored: false, segments, index: text.length, closed: false };
}

export function parseResponseDirectives(response: string): ParsedResponseDirectives {
  const privateResult = stripPrivateBlocks(unwrapDirectiveFences(response));
  if (privateResult.malformed) {
    return { ignored: false, malformedPrivateOutput: true, segments: [] };
  }
  const parsed = parseRange(privateResult.text, 0, { kind: "text" }, null);
  return {
    ignored: parsed.ignored,
    ...(parsed.ignoredText !== undefined ? { ignoredText: parsed.ignoredText } : {}),
    ...(privateResult.thoughts.length > 0 ? { privateThoughts: privateResult.thoughts } : {}),
    segments: parsed.ignored ? [] : normalizeMessageBreaks(parsed.segments),
  };
}

function normalizeMessageBreaks(segments: ResponseSegment[]): ResponseSegment[] {
  const normalized: ResponseSegment[] = [];
  for (const segment of segments) {
    if (segment.kind === "messageBreak") {
      const previous = normalized[normalized.length - 1];
      if (previous?.kind === "emptyMessage" && segment.delivery === undefined) continue;
      if (previous === undefined) {
        if (segment.delivery !== undefined) normalized.push(segment);
        continue;
      }
      if (previous.kind === "messageBreak") {
        if (segment.delivery !== undefined) previous.delivery = segment.delivery;
        continue;
      }
      normalized.push(segment);
      continue;
    }
    normalized.push(segment);
  }

  while (normalized[normalized.length - 1]?.kind === "messageBreak") {
    normalized.pop();
  }

  return normalized;
}

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderSegmentForHistory(segment: ResponseSegment): string {
  if (segment.kind === "text") return segment.text;
  if (segment.kind === "messageBreak") return "[msg-break]";
  if (segment.kind === "emptyMessage") return "";
  return `<voice>${escapeXmlText(segment.text)}</voice>`;
}

export function renderSegmentsForMemory(segments: ResponseSegment[]): string {
  const rendered: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "emptyMessage") continue;
    if (segment.kind === "messageBreak") {
      if (rendered.length > 0) rendered.push(renderSegmentForHistory(segment));
      continue;
    }
    rendered.push(renderSegmentForHistory(segment));
  }
  while (rendered[rendered.length - 1] === "[msg-break]") rendered.pop();
  return rendered.join("\n");
}
