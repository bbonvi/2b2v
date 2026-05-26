import { describe, expect, test } from "bun:test";
import { buildPublicErrorNoticeForError, classifyPublicErrorKind } from "./public-error-notice";

describe("public-error-notice", () => {
  test("classifies reply loop timeout as timeout kind", () => {
    const kind = classifyPublicErrorKind(
      new Error("Native reply loop timed out after 45000ms"),
    );
    expect(kind).toBe("timeout");
  });

  test("builds short russian timeout notice", () => {
    const msg = buildPublicErrorNoticeForError(
      new Error("Native reply loop timed out after 45000ms"),
      "ru",
    );
    expect(msg).toContain("[SYSTEM ERROR]");
    expect(msg).toContain("попробуй еще раз");
    expect(msg.length).toBeLessThan(120);
  });

  test("builds short english generic notice", () => {
    const msg = buildPublicErrorNoticeForError(new Error("unexpected failure"), "en");
    expect(msg).toBe("[SYSTEM ERROR] Internal bot failure. Please try again.");
  });
});
