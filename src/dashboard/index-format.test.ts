import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext, Script } from "node:vm";

interface PayloadTreeHelpers {
  normalizePayloadForTree(payload: unknown): unknown;
  renderPayloadTree(value: unknown, depth: number, keyName?: string): string;
}

interface StageOutputHelpers {
  stageOutput(label: string, value: unknown, emptyText?: string): string;
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
  const helperStart = html.indexOf("const payloadAutoExpandMaxChars =");
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

function loadStageOutputHelpers(): StageOutputHelpers {
  const html = readFileSync("src/dashboard/index.html", "utf8");
  const helperStart = html.indexOf("const stageOutputPreviewChars =");
  const helperEnd = html.indexOf("  function modelResponseText", helperStart);
  if (helperStart < 0 || helperEnd < 0) {
    throw new Error("stage output helper block not found in dashboard HTML");
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
  const context: { extracted?: StageOutputHelpers } = {};
  runInNewContext(`${helperCode}; extracted = { stageOutput };`, context);

  if (context.extracted === undefined) {
    throw new Error("Failed to load stage output helpers");
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

  test("auto-expands nested payload objects unless the node is large", () => {
    const helpers = loadPayloadTreeHelpers();

    const rendered = helpers.renderPayloadTree({
      request: {
        messages: [
          { role: "system", content: "policy" },
          { role: "user", content: "hello" },
        ],
      },
    }, 0);

    expect(rendered).toContain('<details class="payload-collapsible" open>');
    expect(rendered).not.toContain('payload-collapsible payload-large');
  });

  test("collapses tools keys by default", () => {
    const helpers = loadPayloadTreeHelpers();

    const rendered = helpers.renderPayloadTree({
      model: "gpt",
      tools: [
        { name: "search", description: "long enough to distract" },
      ],
    }, 0);

    expect(rendered).toContain('<span class="payload-key">tools</span>');
    expect(rendered).toContain('<details class="payload-collapsible payload-large">');
    expect(rendered).toContain('<summary>[1 item]</summary>');
  });

  test("opens the top-level payload object even when it is large", () => {
    const helpers = loadPayloadTreeHelpers();
    const largePayload = Object.fromEntries(
      Array.from({ length: 141 }, (_, index) => [`key_${index}`, index]),
    );

    const rendered = helpers.renderPayloadTree(largePayload, 0);

    expect(rendered).toContain('<details class="payload-collapsible" open>');
    expect(rendered).toContain('<summary>{141 keys}</summary>');
  });

  test("keeps very large nested payload objects collapsed", () => {
    const helpers = loadPayloadTreeHelpers();
    const largePayload = {
      request: Object.fromEntries(
        Array.from({ length: 141 }, (_, index) => [`key_${index}`, index]),
      ),
    };

    const rendered = helpers.renderPayloadTree(largePayload, 0);

    expect(rendered).toContain('<span class="payload-key">request</span>');
    expect(rendered).toContain('<details class="payload-collapsible payload-large">');
    expect(rendered).toContain('<summary>{141 keys}</summary>');
  });

  test("opens input payloads even when they are large", () => {
    const helpers = loadPayloadTreeHelpers();
    const rendered = helpers.renderPayloadTree({
      input: Array.from({ length: 141 }, (_, index) => ({ text: `message ${index}` })),
    }, 0);

    expect(rendered).toContain('<span class="payload-key">input</span><span><details class="payload-collapsible" open>');
    expect(rendered).toContain('<summary>[141 items]</summary>');
  });

  test("renders long strings inline", () => {
    const helpers = loadPayloadTreeHelpers();
    const longText = "x".repeat(2001);

    const rendered = helpers.renderPayloadTree(longText, 0);

    expect(rendered).toContain('class="payload-primitive payload-string"');
    expect(rendered).toContain(`"${longText}"`);
    expect(rendered).not.toContain('payload-expand-btn');
  });

  test("keeps long strings out of HTML attributes", () => {
    const helpers = loadPayloadTreeHelpers();
    const full = "\"quoted\"\n" + "x".repeat(2001);

    const rendered = helpers.renderPayloadTree(full, 0);

    expect(rendered).not.toContain("data-full=");
    expect(rendered).not.toContain("data-payload-expand-key=");
    expect(rendered).toContain("&quot;quoted&quot;\n");
  });
});

describe("dashboard lifecycle formatting", () => {
  test("uses collapsible request phases with only the main phase open by default", () => {
    const script = loadDashboardScript();

    expect(script).toContain("'<details class=\"' + classes.join(' ') + '\" data-collapse-key=\"phase:'");
    expect(script).toContain("(index === 0 ? ' open' : '')");
    expect(script).toContain("'<summary class=\"request-phase-head\">'");
  });

  test("shows twice as much stage output before offering show more", () => {
    const helpers = loadStageOutputHelpers();
    const atLimit = helpers.stageOutput("response", "x".repeat(1000));
    const overLimit = helpers.stageOutput("response", "x".repeat(1001));

    expect(atLimit).not.toContain('<details class="stage-more">');
    expect(overLimit).toContain('<details class="stage-more"><summary>show more</summary><span>x</span></details>');
  });
});

describe("dashboard memory workspace", () => {
  test("keeps memory editing in its own island and Prompt Lab in Management", () => {
    const html = readFileSync("src/dashboard/index.html", "utf8");

    expect(html).toContain('id="tab-memories"');
    expect(html).toContain('id="memories-tab-root"');
    expect(html).toContain('src="/assets/memories-tab.js"');
    expect(html).toContain('id="lab-prompt"');
    expect(html).not.toContain('id="m-memory-list"');
  });
});
