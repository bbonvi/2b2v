export type VoiceType = "normal" | "whisper";

export type ResponseSegment =
  | { kind: "text"; text: string }
  | { kind: "voice"; text: string; voiceType: VoiceType };

export interface ParsedResponseDirectives {
  ignored: boolean;
  segments: ResponseSegment[];
}

type SegmentMode =
  | { kind: "text" }
  | { kind: "voice"; voiceType: VoiceType };

interface ParseResult {
  ignored: boolean;
  segments: ResponseSegment[];
  index: number;
  closed: boolean;
}

const RESERVED_TAG_RE = /<\s*\/?\s*(?:voice|ignore)\b/i;
const FENCE_RE = /```[ \t]*(?:[a-zA-Z0-9_-]+)?[ \t]*\n?([\s\S]*?)```/g;
const TAG_RE = /<\s*(\/?)\s*(voice|ignore)\b([^>]*)>/gi;

function unwrapDirectiveFences(text: string): string {
  return text.replace(FENCE_RE, (match: string, inner: string) =>
    RESERVED_TAG_RE.test(inner) ? inner : match
  );
}

function parseVoiceType(attrs: string): VoiceType {
  const match = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'/>]+))/i.exec(attrs);
  const raw = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").toLowerCase();
  return raw === "whisper" ? "whisper" : "normal";
}

function pushSegment(
  segments: ResponseSegment[],
  mode: SegmentMode,
  rawText: string,
): void {
  const text = rawText.trim();
  if (text === "") return;
  const next: ResponseSegment = mode.kind === "text"
    ? { kind: "text", text }
    : { kind: "voice", text, voiceType: mode.voiceType };
  const previous = segments[segments.length - 1];
  if (previous !== undefined && previous.kind === "text" && next.kind === "text") {
    previous.text = `${previous.text}\n${next.text}`;
    return;
  }
  if (
    previous !== undefined
    && previous.kind === "voice"
    && next.kind === "voice"
    && previous.voiceType === next.voiceType
  ) {
    previous.text = `${previous.text}\n${next.text}`;
    return;
  }
  segments.push(next);
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

    const nested = parseRange(text, tagEnd, { kind: "voice", voiceType: parseVoiceType(attrs) }, "voice");
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

export function renderSegmentsForMemory(segments: ResponseSegment[]): string {
  return segments.map((segment) => {
    if (segment.kind === "text") return segment.text;
    const label = segment.voiceType === "whisper" ? "voice whisper" : "voice";
    return `[${label}] ${segment.text}`;
  }).join("\n");
}
