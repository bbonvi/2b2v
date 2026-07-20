import { describe, expect, test } from "bun:test";
import { stripMarkdownComments } from "./instruction-text.ts";

describe("stripMarkdownComments", () => {
  test("removes single-line and multiline comments", () => {
    expect(stripMarkdownComments([
      "Keep this.",
      "<!-- Remove this. -->",
      "Keep that.",
      "<!-- Remove",
      "all of this",
      "as well. -->",
      "Done.",
    ].join("\n"))).toBe([
      "Keep this.",
      "",
      "Keep that.",
      "",
      "Done.",
    ].join("\n"));
  });

  test("removes inline comments without changing surrounding text", () => {
    expect(stripMarkdownComments("before<!-- hidden -->after")).toBe("beforeafter");
  });

  test("leaves unclosed comments unchanged", () => {
    expect(stripMarkdownComments("before <!-- unclosed")).toBe("before <!-- unclosed");
  });

  test("reduces comment-only text to whitespace", () => {
    expect(stripMarkdownComments("  <!-- hidden\ninstruction -->  ").trim()).toBe("");
  });
});
