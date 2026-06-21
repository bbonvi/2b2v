import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext, Script } from "node:vm";

type FormatPayload = (obj: unknown) => string;

function loadDashboardScript(): string {
  const html = readFileSync("src/dashboard/index.html", "utf8");
  const match = html.match(/<script>\n([\s\S]*)\n<\/script>/);
  if (match?.[1] === undefined) {
    throw new Error("dashboard inline script not found");
  }
  return match[1];
}

function loadFormatPayload(): FormatPayload {
  const html = readFileSync("src/dashboard/index.html", "utf8");
  const start = html.indexOf("function formatPayload(obj) {");
  if (start < 0) {
    throw new Error("formatPayload function not found in dashboard HTML");
  }

  let depth = 0;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end < 0) {
    throw new Error("formatPayload function end not found");
  }

  const fnCode = html.slice(start, end + 1);
  const context: { extracted?: FormatPayload } = {};
  runInNewContext(`${fnCode}; extracted = formatPayload;`, context);

  if (context.extracted === undefined) {
    throw new Error("Failed to load formatPayload function");
  }

  return context.extracted;
}

describe("dashboard payload formatter", () => {
  test("dashboard inline script parses", () => {
    expect(() => new Script(loadDashboardScript())).not.toThrow();
  });

  test("renders escaped newlines as real line breaks for all multiline strings", () => {
    const formatPayload = loadFormatPayload();

    const rendered = formatPayload({
      messages: [
        {
          role: "user",
          text: "line one\nline two\nline three",
        },
      ],
    });

    expect(rendered).toContain('"text": "line one\nline two\nline three"');
  });

  test("does not turn literal \\n text into a real line break", () => {
    const formatPayload = loadFormatPayload();

    const rendered = formatPayload({
      text: "literal \\n marker",
    });

    expect(rendered).toContain('"text": "literal \\\\n marker"');
  });
});
