import { Type } from "typebox";

export const AssetIdSchema = Type.Union([
  Type.Number(),
  Type.String({ pattern: "^#?[0-9]+$" }),
]);

export type AssetRef = number | string;

export const AssetRefSchema = Type.Union([
  AssetIdSchema,
  Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{1,63}$" }),
]);

/** Accept a positive asset ID with an optional prompt-visible hash prefix. */
export function parseAssetId(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value.replace(/^#/, "")) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Accept either a permanent numeric chat asset or an opaque staged handle. */
export function parseAssetRef(value: unknown): AssetRef | null {
  const id = parseAssetId(value);
  if (id !== null) return id;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^["']|["']$/g, "");
  return /^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(normalized) ? normalized : null;
}
