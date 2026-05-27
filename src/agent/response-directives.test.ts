import { describe, expect, test } from "bun:test";
import { parseResponseDirectives, renderSegmentsForMemory, sanitizeVoiceText } from "./response-directives.ts";

describe("parseResponseDirectives", () => {
  test("returns plain text when no reserved directive exists", () => {
    expect(parseResponseDirectives("<root><item>xml is normal</item></root>")).toEqual({
      ignored: false,
      segments: [{ kind: "text", text: "<root><item>xml is normal</item></root>" }],
    });
  });

  test("does not treat longer XML tag names as reserved directives", () => {
    const xml = "<voice-note>keep as xml</voice-note> <ignore-me>also text</ignore-me>";
    expect(parseResponseDirectives(xml)).toEqual({
      ignored: false,
      segments: [{ kind: "text", text: xml }],
    });
    expect(parseResponseDirectives("```xml\n<voice-note>keep fenced</voice-note>\n```").segments[0]?.text)
      .toBe("```xml\n<voice-note>keep fenced</voice-note>\n```");
  });

  test("parses voice directives and ignores legacy voice attributes", () => {
    expect(parseResponseDirectives("Text <voice>hello</voice> <voice type=\"whisper\">quiet</voice>")).toEqual({
      ignored: false,
      segments: [
        { kind: "text", text: "Text" },
        { kind: "voice", text: "hello" },
        { kind: "voice", text: "quiet" },
      ],
    });
  });

  test("preserves voice tags before TTS and history", () => {
    expect(parseResponseDirectives(
      "<voice>[quiet exhale] Седьмая. [amused] Ладно. [heavy sigh, then amused resignation] Ещё.</voice>"
    )).toEqual({
      ignored: false,
      segments: [
        { kind: "voice", text: "[quiet exhale] Седьмая. [amused] Ладно. [heavy sigh, then amused resignation] Ещё." },
      ],
    });
  });

  test("handles nested voice directives by splitting the nested voice", () => {
    expect(parseResponseDirectives("<voice>outer <voice type=\"whisper\">inner</voice> tail</voice>")).toEqual({
      ignored: false,
      segments: [
        { kind: "voice", text: "outer" },
        { kind: "voice", text: "inner" },
        { kind: "voice", text: "tail" },
      ],
    });
  });

  test("unwraps fenced reserved directives", () => {
    expect(parseResponseDirectives("Okay:\n```xml\n<voice>hello</voice>\n```")).toEqual({
      ignored: false,
      segments: [
        { kind: "text", text: "Okay:" },
        { kind: "voice", text: "hello" },
      ],
    });
  });

  test("preserves non-reserved fenced XML", () => {
    expect(parseResponseDirectives("```xml\n<root>ok</root>\n```").segments[0]?.text)
      .toBe("```xml\n<root>ok</root>\n```");
  });

  test("ignore directive suppresses all output", () => {
    expect(parseResponseDirectives("not sending <ignore>spam</ignore>")).toEqual({
      ignored: true,
      segments: [],
    });
  });

  test("gracefully handles malformed reserved tags", () => {
    expect(parseResponseDirectives("<voice>hello").segments).toEqual([
      { kind: "voice", text: "hello" },
    ]);
    expect(parseResponseDirectives("</voice> hello").segments).toEqual([
      { kind: "text", text: "</voice>\nhello" },
    ]);
  });
});

describe("sanitizeVoiceText", () => {
  test("preserves voice tags and normalizes whitespace", () => {
    expect(sanitizeVoiceText("[ANGRY] hello [sings] there [hard pause] ok [heavy sigh, then amused resignation]"))
      .toBe("[ANGRY] hello [sings] there [hard pause] ok [heavy sigh, then amused resignation]");
  });
});

describe("renderSegmentsForMemory", () => {
  test("preserves voice directives as XML for history and memory context", () => {
    expect(renderSegmentsForMemory([
      { kind: "text", text: "text" },
      { kind: "voice", text: "voice" },
      { kind: "voice", text: "[whispers] quiet" },
    ])).toBe('text\n<voice>voice</voice>\n<voice>[whispers] quiet</voice>');
  });

  test("escapes voice text when rendering XML for history", () => {
    expect(renderSegmentsForMemory([
      { kind: "voice", text: "2 < 3 & ok" },
    ])).toBe("<voice>2 &lt; 3 &amp; ok</voice>");
  });
});
