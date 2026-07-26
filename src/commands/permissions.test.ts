import { describe, test, expect } from "bun:test";
import { PermissionFlagsBits } from "discord.js";
import { isAdmin, type PermissionContext } from "./permissions.ts";

describe("isAdmin", () => {
  test("accepts Discord administrators and configured fallback administrators", () => {
    const cases: Array<{ context: PermissionContext; expected: boolean }> = [
      {
        context: {
          memberPermissions: PermissionFlagsBits.Administrator | PermissionFlagsBits.SendMessages,
          userId: "999",
          adminUserIds: [],
        },
        expected: true,
      },
      {
        context: {
          memberPermissions: PermissionFlagsBits.SendMessages,
          userId: "999",
          adminUserIds: [],
        },
        expected: false,
      },
      {
        context: {
          memberPermissions: null,
          userId: "123",
          adminUserIds: ["123", "456"],
        },
        expected: true,
      },
      {
        context: {
          memberPermissions: null,
          userId: "789",
          adminUserIds: ["123"],
        },
        expected: false,
      },
      {
        context: {
          memberPermissions: PermissionFlagsBits.SendMessages,
          userId: "123",
          adminUserIds: ["123"],
        },
        expected: true,
      },
    ];

    for (const { context, expected } of cases) {
      expect(isAdmin(context)).toBe(expected);
    }
  });
});
