export type ResponseSegment =
  | { kind: "text"; text: string }
  | { kind: "voice"; text: string };

export interface ParsedResponseDirectives {
  ignored: boolean;
  segments: ResponseSegment[];
}

type SegmentMode =
  | { kind: "text" }
  | { kind: "voice" };

interface ParseResult {
  ignored: boolean;
  segments: ResponseSegment[];
  index: number;
  closed: boolean;
}

const RESERVED_TAG_RE = /<\s*\/?\s*(?:voice|ignore)(?=[\s/>])/i;
const FENCE_RE = /```[ \t]*(?:[a-zA-Z0-9_-]+)?[ \t]*\n?([\s\S]*?)```/g;
const TAG_RE = /<\s*(\/?)\s*(voice|ignore)(?=[\s/>])([^>]*)>/gi;
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
  stopTag: "voice" | "ignore" | null,
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
    const tag = rawTag.toLowerCase() as "voice" | "ignore";
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
      return { ignored: true, segments, index: text.length, closed: false };
    }

    if (selfClosing) {
      cursor = tagEnd;
      continue;
    }

    const nested = parseRange(text, tagEnd, { kind: "voice" }, "voice");
    segments.push(...nested.segments);
    if (nested.ignored) {
      return { ignored: true, segments, index: text.length, closed: false };
    }
    cursor = nested.index;
    tagRe.lastIndex = cursor;
  }

  pushSegment(segments, mode, text.slice(cursor));
  return { ignored: false, segments, index: text.length, closed: false };
}

export function parseResponseDirectives(response: string): ParsedResponseDirectives {
  const normalized = unwrapDirectiveFences(response);
  const parsed = parseRange(normalized, 0, { kind: "text" }, null);
  return {
    ignored: parsed.ignored,
    segments: parsed.ignored ? [] : parsed.segments,
  };
}

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderSegmentForHistory(segment: ResponseSegment): string {
  if (segment.kind === "text") return segment.text;
  return `<voice>${escapeXmlText(segment.text)}</voice>`;
}

export function renderSegmentsForMemory(segments: ResponseSegment[]): string {
  return segments.map(renderSegmentForHistory).join("\n");
}
