import { test, expect, describe } from "bun:test";
import { imagePath } from "./image-storage.ts";

describe("imagePath", () => {
  test("produces deterministic path", () => {
    expect(imagePath("data/attachments", "111", "222", 1, "webp")).toBe(
      "data/attachments/111-222/images/1.webp"
    );
  });

  test("uses absolute attachmentsDir when provided", () => {
    expect(imagePath("/srv/attachments", "g1", "c1", 42, "png")).toBe(
      "/srv/attachments/g1-c1/images/42.png"
    );
  });

  test("different channels produce different paths", () => {
    const a = imagePath("data/attachments", "g", "c1", 1, "webp");
    const b = imagePath("data/attachments", "g", "c2", 1, "webp");
    expect(a).not.toBe(b);
  });

  test("different image IDs produce different paths", () => {
    const a = imagePath("data/attachments", "g", "c", 1, "webp");
    const b = imagePath("data/attachments", "g", "c", 2, "webp");
    expect(a).not.toBe(b);
  });
});
