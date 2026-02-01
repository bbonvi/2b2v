import { describe, test, expect, mock } from "bun:test";
import { registerSlashCommands } from "./registry.ts";

// Mock discord.js REST — we intercept the put call
const putMock = mock(() => Promise.resolve([{ id: "cmd-1" }, { id: "cmd-2" }]));

mock.module("discord.js", () => ({
  REST: class {
    setToken(_token: string) {
      return this;
    }
    put = putMock;
  },
  Routes: {
    applicationCommands: (clientId: string) => `/applications/${clientId}/commands`,
  },
}));

describe("registerSlashCommands", () => {
  test("returns count of registered commands from array result", async () => {
    putMock.mockResolvedValueOnce([{ id: "cmd-1" }, { id: "cmd-2" }, { id: "cmd-3" }]);

    const count = await registerSlashCommands({
      token: "test-token",
      clientId: "client-123",
      commands: [
        { name: "status", description: "Bot status" },
        { name: "config", description: "Guild config" },
        { name: "schedule", description: "Schedules" },
      ],
    });

    expect(count).toBe(3);
  });

  test("returns 0 when REST result is not an array", async () => {
    putMock.mockResolvedValueOnce({ message: "ok" });

    const count = await registerSlashCommands({
      token: "test-token",
      clientId: "client-123",
      commands: [{ name: "status", description: "Bot status" }],
    });

    expect(count).toBe(0);
  });

  test("propagates REST errors", async () => {
    putMock.mockRejectedValueOnce(new Error("Unauthorized"));

    await expect(
      registerSlashCommands({
        token: "bad-token",
        clientId: "client-123",
        commands: [],
      })
    ).rejects.toThrow("Unauthorized");
  });

  test("passes commands as body to REST put", async () => {
    const commands = [
      { name: "ping", description: "Ping" },
      { name: "pong", description: "Pong" },
    ];
    putMock.mockResolvedValueOnce(commands.map((c) => ({ id: c.name })));

    await registerSlashCommands({
      token: "test-token",
      clientId: "app-456",
      commands,
    });

    expect(putMock).toHaveBeenCalledWith("/applications/app-456/commands", {
      body: commands,
    });
  });
});
