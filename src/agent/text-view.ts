import { runRipgrep as runRipgrepProcess } from "./ripgrep.ts";

export const DISPLAY_LINE_MAX_CHARS = 4_000;

export interface TextLineRange {
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  hasMore: boolean;
}

/** Split source text into stable bounded display lines without dropping content. */
export function displayLines(text: string, maxLineChars = DISPLAY_LINE_MAX_CHARS): string[] {
  const sourceLines = text.replace(/\r\n?/g, "\n").split("\n");
  const result: string[] = [];
  for (const sourceLine of sourceLines) {
    let rest = sourceLine;
    if (rest === "") {
      result.push("");
      continue;
    }
    while (rest.length > maxLineChars) {
      const window = rest.slice(0, maxLineChars);
      const tagBoundary = window.lastIndexOf(">");
      const whitespaceBoundary = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\t"));
      const splitAt = tagBoundary >= Math.floor(maxLineChars / 2)
        ? tagBoundary + 1
        : whitespaceBoundary >= Math.floor(maxLineChars / 2)
          ? whitespaceBoundary + 1
          : maxLineChars;
      result.push(rest.slice(0, splitAt));
      rest = rest.slice(splitAt);
    }
    result.push(rest);
  }
  return result;
}

/** Render one numbered, character-bounded range from an agent-readable text view. */
export function renderTextRange(
  text: string,
  requestedStart: number,
  requestedCount: number,
  maxChars: number,
): TextLineRange {
  const lines = displayLines(text);
  if (requestedStart > lines.length) {
    throw new Error(`start_line ${requestedStart} exceeds the ${lines.length} available lines.`);
  }
  const selected: string[] = [];
  let endLine = requestedStart - 1;
  let chars = 0;
  for (let index = requestedStart - 1; index < lines.length && selected.length < requestedCount; index += 1) {
    const rendered = `${index + 1} | ${lines[index] ?? ""}`;
    const separatorChars = selected.length > 0 ? 1 : 0;
    if (chars + separatorChars + rendered.length > maxChars) break;
    selected.push(rendered);
    chars += separatorChars + rendered.length;
    endLine = index + 1;
  }
  if (selected.length === 0) {
    throw new Error(`Line ${requestedStart} cannot fit within the ${maxChars} character read limit.`);
  }
  return {
    text: selected.join("\n"),
    startLine: requestedStart,
    endLine,
    totalLines: lines.length,
    hasMore: endLine < lines.length,
  };
}

/** Regex-search a bounded display view with ripgrep syntax. */
export async function searchTextView(
  text: string,
  pattern: string,
  contextLines: number,
  maxResults: number,
  maxChars: number,
  signal: AbortSignal,
): Promise<string | null> {
  const stdout = await runRipgrepProcess([
    "--line-number",
    "--text",
    "--no-filename",
    "--no-heading",
    "--color=never",
    `--context=${contextLines}`,
    `--max-count=${maxResults}`,
    `--max-columns=${DISPLAY_LINE_MAX_CHARS}`,
    "--max-columns-preview",
    "--regexp",
    pattern,
  ], displayLines(text).join("\n"), signal);
  if (stdout === null) return null;
  const clean = stdout.trim();
  if (clean.length <= maxChars) return clean;
  const cutoff = clean.lastIndexOf("\n", maxChars);
  return `${clean.slice(0, cutoff > 0 ? cutoff : maxChars)}\n[Search output truncated; narrow the regex.]`;
}
