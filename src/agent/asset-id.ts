import { Type } from "typebox";

export const AssetIdSchema = Type.Union([
  Type.Number(),
  Type.String({ pattern: "^#?[0-9]+$" }),
]);

/** Accept a positive asset ID with an optional prompt-visible hash prefix. */
export function parseAssetId(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value.replace(/^#/, "")) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
