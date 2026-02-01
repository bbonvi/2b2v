import { PermissionFlagsBits } from "discord.js";

export interface PermissionContext {
  /** Discord member permissions bitfield (BigInt or null if unavailable). */
  memberPermissions: bigint | null;
  /** User ID of the command invoker. */
  userId: string;
  /** Per-guild admin user ID fallback list. */
  adminUserIds: string[];
}

/**
 * Determine whether the invoking user has admin privileges.
 * Checks Discord Administrator permission first; falls back to per-guild adminUserIds list.
 */
export function isAdmin(ctx: PermissionContext): boolean {
  if (ctx.memberPermissions !== null) {
    if ((ctx.memberPermissions & PermissionFlagsBits.Administrator) !== 0n) {
      return true;
    }
  }
  return ctx.adminUserIds.includes(ctx.userId);
}
