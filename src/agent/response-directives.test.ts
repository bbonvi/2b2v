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
    expect(parseResponseDirectives("```xml\n<voice-note>keep fenced</voice-note>\n```").segments[0])
      .toEqual({ kind: "text", text: "```xml\n<voice-note>keep fenced</voice-note>\n```" });
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

  test("strips private scene cards before parsing visible output", () => {
    expect(parseResponseDirectives("<scene perspective=\"outside_character_editor\">\nroom read: test\n</scene>\n<message>visible</message>")).toEqual({
      ignored: false,
      segments: [{ kind: "text", text: "visible" }],
    });
    expect(parseResponseDirectives("<scene>private</scene>\nplain visible")).toEqual({
      ignored: false,
      segments: [{ kind: "text", text: "plain visible" }],
    });
  });

  test("parses audio as a voice directive alias", () => {
    expect(parseResponseDirectives("Text <audio>hello</audio>")).toEqual({
      ignored: false,
      segments: [
        { kind: "text", text: "Text" },
        { kind: "voice", text: "hello" },
      ],
    });
  });

  test("parses message directives as send boundaries", () => {
    expect(parseResponseDirectives("<message>first</message><message>second</message>")).toEqual({
      ignored: false,
      segments: [
        { kind: "text", text: "first" },
        { kind: "messageBreak" },
        { kind: "text", text: "second" },
      ],
    });
  });

  test("parses message delivery attributes", () => {
    expect(parseResponseDirectives("<message channel_id=\"chan-2\" reply=\"false\" keep_typing=\"true\">first</message><message reply_to=\"12345\">second</message>")).toEqual({
      ignored: false,
      segments: [
        { kind: "messageBreak", delivery: { channelId: "chan-2", reply: false, keepTyping: true } },
        { kind: "text", text: "first" },
        { kind: "messageBreak", delivery: { replyTo: "12345" } },
        { kind: "text", text: "second" },
      ],
    });
  });

  test("ignores legacy chat_id delivery attributes", () => {
    expect(parseResponseDirectives("<message chat_id=\"chan-2\">first</message>")).toEqual({
      ignored: false,
      segments: [{ kind: "text", text: "first" }],
    });
  });

  test("parses message image_ids delivery attribute", () => {
    expect(parseResponseDirectives("<message image_ids=[12, 13]>again</message><message image_ids=\"[14]\">quoted</message>")).toEqual({
      ignored: false,
      segments: [
        { kind: "messageBreak", delivery: { imageIds: [12, 13] } },
        { kind: "text", text: "again" },
        { kind: "messageBreak", delivery: { imageIds: [14] } },
        { kind: "text", text: "quoted" },
      ],
    });
  });

  test("preserves image-only message directives", () => {
    expect(parseResponseDirectives("<message image_ids=[12]></message><message>next</message>")).toEqual({
      ignored: false,
      segments: [
        { kind: "emptyMessage", delivery: { imageIds: [12] } },
        { kind: "text", text: "next" },
      ],
    });
  });

  test("allows audio directives inside message directives", () => {
    expect(parseResponseDirectives("<message>text</message><message><audio>spoken</audio></message>")).toEqual({
      ignored: false,
      segments: [
        { kind: "text", text: "text" },
        { kind: "messageBreak" },
        { kind: "voice", text: "spoken" },
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

  test("moves Discord-only text out of voice directives", () => {
    expect(parseResponseDirectives("<voice>@user, hey #general there</voice>")).toEqual({
      ignored: false,
      segments: [
        { kind: "text", text: "@user" },
        { kind: "voice", text: "hey" },
        { kind: "text", text: "#general" },
        { kind: "voice", text: "there" },
      ],
    });
    expect(parseResponseDirectives("<voice>hey @<User.Name>! https://example.com</voice>")).toEqual({
      ignored: false,
      segments: [
        { kind: "voice", text: "hey" },
        { kind: "text", text: "@<User.Name>\nhttps://example.com" },
      ],
    });
  });

  test("does not move mass pings out of voice directives", () => {
    expect(parseResponseDirectives("<voice>@everyone hey</voice>")).toEqual({
      ignored: false,
      segments: [
        { kind: "voice", text: "@everyone hey" },
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
    expect(parseResponseDirectives("```xml\n<root>ok</root>\n```").segments[0])
      .toEqual({ kind: "text", text: "```xml\n<root>ok</root>\n```" });
  });

  test("ignore directive suppresses all output", () => {
    expect(parseResponseDirectives(" \n<ignore>spam</ignore>")).toEqual({
      ignored: true,
      ignoredText: "<ignore>spam</ignore>",
      segments: [],
    });
  });

  test("late ignore directives do not cancel already parsed output", () => {
    expect(parseResponseDirectives("<message>first</message><ignore>skip</ignore>")).toEqual({
      ignored: false,
      segments: [{ kind: "text", text: "first" }],
    });
    expect(parseResponseDirectives("<message>first</message><message><ignore>skip</ignore></message><message>second</message>")).toEqual({
      ignored: false,
      segments: [
        { kind: "text", text: "first" },
        { kind: "messageBreak" },
        { kind: "text", text: "second" },
      ],
    });
  });

  test("normalizes ignore directive text for prompt-only history", () => {
    expect(parseResponseDirectives("<message><ignore>\n  enough \n</ignore></message>")).toEqual({
      ignored: true,
      ignoredText: "<ignore>enough</ignore>",
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

  test("renders message boundaries as historical msg-break markers", () => {
    expect(renderSegmentsForMemory([
      { kind: "text", text: "first" },
      { kind: "messageBreak" },
      { kind: "text", text: "second" },
    ])).toBe("first\n[msg-break]\nsecond");
  });

  test("does not render leading delivery metadata as a msg-break", () => {
    expect(renderSegmentsForMemory([
      { kind: "messageBreak", delivery: { reply: false } },
      { kind: "text", text: "first" },
    ])).toBe("first");
  });

  test("escapes voice text when rendering XML for history", () => {
    expect(renderSegmentsForMemory([
      { kind: "voice", text: "2 < 3 & ok" },
    ])).toBe("<voice>2 &lt; 3 &amp; ok</voice>");
  });
});
