import { describe, expect, test } from "bun:test";
import { parseResponseDirectives, renderSegmentsForMemory } from "./response-directives.ts";

describe("parseResponseDirectives", () => {
  test("returns plain text when no reserved directive exists", () => {
    expect(parseResponseDirectives("<root><item>xml is normal</item></root>")).toEqual({
      ignored: false,
      segments: [{ kind: "text", text: "<root><item>xml is normal</item></root>" }],
    });
  });

  test("parses voice and whisper directives", () => {
    expect(parseResponseDirectives("Text <voice>hello</voice> <voice type=\"whisper\">quiet</voice>")).toEqual({
      ignored: false,
      segments: [
        { kind: "text", text: "Text" },
        { kind: "voice", text: "hello", voiceType: "normal" },
        { kind: "voice", text: "quiet", voiceType: "whisper" },
      ],
    });
  });

  test("handles nested voice directives by splitting the nested voice", () => {
    expect(parseResponseDirectives("<voice>outer <voice type=\"whisper\">inner</voice> tail</voice>")).toEqual({
      ignored: false,
      segments: [
        { kind: "voice", text: "outer", voiceType: "normal" },
        { kind: "voice", text: "inner", voiceType: "whisper" },
        { kind: "voice", text: "tail", voiceType: "normal" },
      ],
    });
  });

  test("unwraps fenced reserved directives", () => {
    expect(parseResponseDirectives("Okay:\n```xml\n<voice>hello</voice>\n```")).toEqual({
      ignored: false,
      segments: [
        { kind: "text", text: "Okay:" },
        { kind: "voice", text: "hello", voiceType: "normal" },
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
      { kind: "voice", text: "hello", voiceType: "normal" },
    ]);
    expect(parseResponseDirectives("</voice> hello").segments).toEqual([
      { kind: "text", text: "</voice>\nhello" },
    ]);
  });
});

describe("renderSegmentsForMemory", () => {
  test("labels voice segments for memory extraction", () => {
    expect(renderSegmentsForMemory([
      { kind: "text", text: "text" },
      { kind: "voice", text: "voice", voiceType: "normal" },
      { kind: "voice", text: "quiet", voiceType: "whisper" },
    ])).toBe("text\n[voice] voice\n[voice whisper] quiet");
  });
});
