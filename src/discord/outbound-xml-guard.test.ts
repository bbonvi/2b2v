import { describe, expect, test } from "bun:test";
import { assertSafeDiscordText, OutboundXmlTagError } from "./outbound-xml-guard.ts";

describe("assertSafeDiscordText", () => {
  test("rejects complete and malformed XML-like tags", () => {
    for (const text of [
      "<thoughts>lmao",
      "before <thought",
      "<root>text</root>",
      "before </private>",
      '<internal value="secret">text',
    ]) {
      expect(() => assertSafeDiscordText(text)).toThrow(OutboundXmlTagError);
    }
  });

  test("allows XML-like examples inside complete matching backticks", () => {
    for (const delimiter of ["`", "``", "```", "````"]) {
      expect(() => assertSafeDiscordText(
        `${delimiter}<thoughts>lmao${delimiter}`,
      )).not.toThrow();
    }
  });

  test("does not let an unmatched backtick hide XML-like markup", () => {
    expect(() => assertSafeDiscordText("`example <thoughts>lmao")).toThrow(OutboundXmlTagError);
  });

  test("allows normal Discord text syntax", () => {
    expect(() => assertSafeDiscordText("hello <@123> <#456> <:wave:789> https://example.com")).not.toThrow();
  });
});
