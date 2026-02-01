import { describe, test, expect } from "bun:test";
import { PermissionFlagsBits } from "discord.js";
import { isAdmin, type PermissionContext } from "./permissions.ts";

describe("isAdmin", () => {
  test("returns true when member has Administrator permission", () => {
    const ctx: PermissionContext = {
      memberPermissions: PermissionFlagsBits.Administrator | PermissionFlagsBits.SendMessages,
      userId: "999",
      adminUserIds: [],
    };
    expect(isAdmin(ctx)).toBe(true);
  });

  test("returns false when member lacks Administrator permission", () => {
    const ctx: PermissionContext = {
      memberPermissions: PermissionFlagsBits.SendMessages,
      userId: "999",
      adminUserIds: [],
    };
    expect(isAdmin(ctx)).toBe(false);
  });

  test("returns true when userId is in adminUserIds fallback", () => {
    const ctx: PermissionContext = {
      memberPermissions: null,
      userId: "123",
      adminUserIds: ["123", "456"],
    };
    expect(isAdmin(ctx)).toBe(true);
  });

  test("returns false when userId not in fallback and no permissions", () => {
    const ctx: PermissionContext = {
      memberPermissions: null,
      userId: "789",
      adminUserIds: ["123"],
    };
    expect(isAdmin(ctx)).toBe(false);
  });

  test("falls back to adminUserIds when Discord perms deny admin", () => {
    const ctx: PermissionContext = {
      memberPermissions: PermissionFlagsBits.SendMessages,
      userId: "123",
      adminUserIds: ["123"],
    };
    expect(isAdmin(ctx)).toBe(true);
  });
});
