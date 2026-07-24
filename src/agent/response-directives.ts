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
  /** Invalid message-envelope attributes that prevent delivery. */
  directiveErrors?: string[];
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

interface ParsedAttribute {
  name: string;
  value: string;
}

interface ParseContext {
  directiveErrors: string[];
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

function parseAttributes(attrs: string): { attributes: ParsedAttribute[]; errors: string[] } {
  const attributes: ParsedAttribute[] = [];
  const errors: string[] = [];
  let cursor = 0;

  while (cursor < attrs.length) {
    while (cursor < attrs.length && /\s/.test(attrs[cursor] ?? "")) cursor += 1;
    if (cursor >= attrs.length || attrs[cursor] === "/") break;

    const nameMatch = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(attrs.slice(cursor));
    if (nameMatch === null) {
      errors.push(`Invalid <message> attribute syntax near "${attrs.slice(cursor).trim()}".`);
      break;
    }
    const name = nameMatch[0].toLowerCase();
    cursor += nameMatch[0].length;
    while (cursor < attrs.length && /\s/.test(attrs[cursor] ?? "")) cursor += 1;
    if (attrs[cursor] !== "=") {
      errors.push(`Attribute "${name}" must have a value.`);
      break;
    }
    cursor += 1;
    while (cursor < attrs.length && /\s/.test(attrs[cursor] ?? "")) cursor += 1;

    const first = attrs[cursor];
    let rawValue = "";
    if (first === "\"" || first === "'") {
      const end = attrs.indexOf(first, cursor + 1);
      if (end === -1) {
        errors.push(`Attribute "${name}" has an unterminated quoted value.`);
        break;
      }
      rawValue = attrs.slice(cursor + 1, end);
      cursor = end + 1;
    } else if (first === "[") {
      const end = attrs.indexOf("]", cursor + 1);
      if (end === -1) {
        errors.push(`Attribute "${name}" has an unterminated array value.`);
        break;
      }
      rawValue = attrs.slice(cursor, end + 1);
      cursor = end + 1;
    } else {
      const valueMatch = /^[^\s"'>/]+/.exec(attrs.slice(cursor));
      if (valueMatch === null) {
        errors.push(`Attribute "${name}" must have a value.`);
        break;
      }
      rawValue = valueMatch[0];
      cursor += rawValue.length;
    }
    attributes.push({ name, value: unescapeAttributeValue(rawValue).trim() });
  }

  return { attributes, errors };
}

function parseMessageDelivery(attrs: string): { delivery?: MessageDelivery; errors: string[] } {
  const delivery: MessageDelivery = {};
  const parsed = parseAttributes(attrs);
  const errors = [...parsed.errors];
  const seen = new Set<string>();
  const supported = new Set(["channel_id", "reply", "reply_to", "keep_typing", "asset_ids"]);

  for (const attribute of parsed.attributes) {
    const { name, value } = attribute;
    if (!supported.has(name)) {
      errors.push(`Unknown <message> attribute "${name}".`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`Duplicate <message> attribute "${name}".`);
      continue;
    }
    seen.add(name);

    if (name === "channel_id") {
      if (value === "") errors.push('Attribute "channel_id" must not be empty.');
      else delivery.channelId = value;
    } else if (name === "reply" || name === "keep_typing") {
      const normalized = value.toLowerCase();
      if (normalized !== "true" && normalized !== "false") {
        errors.push(`Attribute "${name}" must be "true" or "false".`);
      } else if (name === "reply") {
        delivery.reply = normalized === "true";
      } else {
        delivery.keepTyping = normalized === "true";
      }
    } else if (name === "reply_to") {
      if (value === "") errors.push('Attribute "reply_to" must not be empty.');
      else delivery.replyTo = value;
    } else {
      const assetIds = parseAssetIdsValue(value);
      if (assetIds === null) {
        errors.push(`Attribute "asset_ids" contains an invalid asset reference: "${value}".`);
      } else if (assetIds.length === 0) {
        errors.push('Attribute "asset_ids" must contain at least one asset reference.');
      } else {
        delivery.assetIds = assetIds;
      }
    }
  }

  const hasDelivery = delivery.channelId !== undefined
    || delivery.reply !== undefined
    || delivery.replyTo !== undefined
    || delivery.keepTyping !== undefined
    || delivery.assetIds !== undefined;
  return { ...(hasDelivery ? { delivery } : {}), errors };
}

function parseAssetIdsValue(raw: string): AssetRef[] | null {
  const isArray = raw.startsWith("[") && raw.endsWith("]");
  const inner = isArray ? raw.slice(1, -1).trim() : raw.trim();
  if (inner === "") return [];
  const parts = isArray ? inner.split(",") : [inner];
  const ids = parts.map((part) => parseAssetRef(part.trim()));
  return ids.every((id) => id !== null) ? ids : null;
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
  context: ParseContext,
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
      const parsedDelivery = parseMessageDelivery(attrs);
      context.directiveErrors.push(...parsedDelivery.errors);
      const delivery = parsedDelivery.delivery;
      const nested = parseRange(text, tagEnd, { kind: "text" }, "message", context);
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

    const nested = parseRange(text, tagEnd, { kind: "voice" }, tag, context);
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
  const context: ParseContext = { directiveErrors: [] };
  const parsed = parseRange(privateResult.text, 0, { kind: "text" }, null, context);
  return {
    ignored: parsed.ignored,
    ...(parsed.ignoredText !== undefined ? { ignoredText: parsed.ignoredText } : {}),
    ...(context.directiveErrors.length > 0 ? { directiveErrors: context.directiveErrors } : {}),
    ...(privateResult.thoughts.length > 0 ? { privateThoughts: privateResult.thoughts } : {}),
    segments: parsed.ignored || context.directiveErrors.length > 0
      ? []
      : normalizeMessageBreaks(parsed.segments),
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
