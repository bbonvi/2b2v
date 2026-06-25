import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext, Script } from "node:vm";

interface PayloadTreeHelpers {
  normalizePayloadForTree(payload: unknown): unknown;
  renderPayloadTree(value: unknown, depth: number): string;
}

function loadDashboardScript(): string {
  const html = readFileSync("src/dashboard/index.html", "utf8");
  const match = html.match(/<script>\n([\s\S]*)\n<\/script>/);
  if (match?.[1] === undefined) {
    throw new Error("dashboard inline script not found");
  }
  return match[1];
}

function loadPayloadTreeHelpers(): PayloadTreeHelpers {
  const html = readFileSync("src/dashboard/index.html", "utf8");
  const helperStart = html.indexOf("function payloadType(value) {");
  const helperEnd = html.indexOf("  const modalTitle", helperStart);
  if (helperStart < 0 || helperEnd < 0) {
    throw new Error("payload tree helper block not found in dashboard HTML");
  }
  const helperCode = [
    `function esc(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    }`,
    html.slice(helperStart, helperEnd),
  ].join("\n");
  const context: { extracted?: PayloadTreeHelpers } = {};
  runInNewContext(
    `${helperCode}; extracted = { normalizePayloadForTree, renderPayloadTree };`,
    context,
  );

  if (context.extracted === undefined) {
    throw new Error("Failed to load payload tree helpers");
  }

  return context.extracted;
}

describe("dashboard payload formatter", () => {
  test("dashboard inline script parses", () => {
    expect(() => new Script(loadDashboardScript())).not.toThrow();
  });

  test("renders escaped newlines as real line breaks for all multiline strings", () => {
    const helpers = loadPayloadTreeHelpers();

    const rendered = helpers.renderPayloadTree({
      messages: [
        {
          role: "user",
          text: "line one\nline two\nline three",
        },
      ],
    }, 0);

    expect(rendered).toContain('"line one\nline two\nline three"');
  });

  test("does not turn literal \\n text into a real line break", () => {
    const helpers = loadPayloadTreeHelpers();

    const rendered = helpers.renderPayloadTree({
      text: "literal \\n marker",
    }, 0);

    expect(rendered).toContain('"literal \\n marker"');
    expect(rendered).not.toContain('"literal \n marker"');
  });
});
