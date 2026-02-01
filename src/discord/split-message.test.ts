import { test, expect, describe } from "bun:test";
import { splitMessage } from "./split-message";

describe("splitMessage", () => {
  test("text under limit returns single chunk unchanged", () => {
    expect(splitMessage("hello", 2000)).toEqual(["hello"]);
  });

  test("multi-line text exceeding limit splits at line breaks", () => {
    const line = "a".repeat(30) + "\n";
    const text = line.repeat(5); // 155 chars
    const chunks = splitMessage(text, 80);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(80);
    }
    expect(chunks.join("")).toBe(text);
  });

  test("single long line splits at sentence boundaries", () => {
    // No newlines, but has sentences
    const text = "Hello world. This is a test. Another sentence here. Final words without a period";
    const chunks = splitMessage(text, 30);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
    expect(chunks.join("")).toBe(text);
  });

  test("single long sentence with no breaks hard-cuts at limit", () => {
    const text = "a".repeat(50);
    const chunks = splitMessage(text, 20);
    expect(chunks).toEqual(["a".repeat(20), "a".repeat(20), "a".repeat(10)]);
  });

  test("exactly 2000 chars returns single chunk", () => {
    const text = "x".repeat(2000);
    expect(splitMessage(text)).toEqual([text]);
  });

  test("2001 chars with newline at 1999 splits at that newline", () => {
    const text = "a".repeat(1999) + "\n" + "b";
    const chunks = splitMessage(text, 2000);
    expect(chunks).toEqual(["a".repeat(1999) + "\n", "b"]);
  });

  test("empty string returns ['']", () => {
    expect(splitMessage("")).toEqual([""]);
  });

  test("multiple consecutive newlines preserved", () => {
    const text = "hello\n\n\nworld";
    const chunks = splitMessage(text, 8);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(8);
    }
  });

  test("chunks never exceed limit (randomized long strings)", () => {
    const chars = "abcdefghijklmnop\n. ! ? ";
    let text = "";
    for (let i = 0; i < 5000; i++) {
      text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    const limit = 100;
    const chunks = splitMessage(text, limit);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
    }
    expect(chunks.join("")).toBe(text);
  });

  test("concatenation of chunks equals original (lossless)", () => {
    const text = "Line one\nLine two is a bit longer than the first.\nLine three.\nEnd";
    const chunks = splitMessage(text, 25);
    expect(chunks.join("")).toBe(text);
  });
});
