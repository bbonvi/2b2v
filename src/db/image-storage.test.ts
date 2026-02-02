import { test, expect, describe } from "bun:test";
import { imagePath } from "./image-storage.ts";

describe("imagePath", () => {
  test("produces deterministic path", () => {
    expect(imagePath("data/attachments", "111", "222", 1)).toBe(
      "data/attachments/111-222/images/1.jpg"
    );
  });

  test("uses absolute attachmentsDir when provided", () => {
    expect(imagePath("/srv/attachments", "g1", "c1", 42)).toBe(
      "/srv/attachments/g1-c1/images/42.jpg"
    );
  });

  test("different channels produce different paths", () => {
    const a = imagePath("data/attachments", "g", "c1", 1);
    const b = imagePath("data/attachments", "g", "c2", 1);
    expect(a).not.toBe(b);
  });

  test("different image IDs produce different paths", () => {
    const a = imagePath("data/attachments", "g", "c", 1);
    const b = imagePath("data/attachments", "g", "c", 2);
    expect(a).not.toBe(b);
  });
});
