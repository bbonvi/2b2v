import { describe, expect, test } from "bun:test";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { createReadUserAvatarTool, type ReadUserAvatarToolDeps, type ResolvedUserAvatar } from "./read-user-avatar-tool";

function response(buffer: Buffer, contentType = "image/png"): Awaited<ReturnType<ReadUserAvatarToolDeps["fetchFn"]>> {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    arrayBuffer: () => Promise.resolve(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer),
  };
}

function makeDeps(overrides?: Partial<ReadUserAvatarToolDeps>): ReadUserAvatarToolDeps {
  return {
    resolveUserAvatar: (reference, size) => Promise.resolve({
      userId: "u1",
      username: reference.replace(/^@/, ""),
      displayName: "Alice A",
      avatarUrl: `https://cdn.example/avatar-${size}.png`,
      requestedSize: size,
    }),
    fetchFn: () => Promise.resolve(response(Buffer.from("avatar-bytes"))),
    prepareImageForContext: (buffer, mimeType) => Promise.resolve({
      data: Buffer.from(`prepared-${mimeType}-${buffer.toString()}`),
      mime: "image/jpeg",
      width: 256,
      height: 256,
    }),
    ...overrides,
  };
}

describe("createReadUserAvatarTool", () => {
  test("returns tool metadata", () => {
    const tool = createReadUserAvatarTool(makeDeps());
    expect(tool.name).toBe("read_user_avatar");
    expect(tool.label).toBe("read_user_avatar");
    expect(tool.parameters).toBeDefined();
  });

  test("fetches and prepares avatar image content", async () => {
    const calls: string[] = [];
    const tool = createReadUserAvatarTool(makeDeps({
      resolveUserAvatar: (reference, size) => {
        calls.push(`${reference}:${size}`);
        return Promise.resolve({
          userId: "42",
          username: "alice",
          displayName: "Alice A",
          avatarUrl: "https://cdn.example/alice.png",
          requestedSize: size,
        });
      },
    }));

    const result = await tool.execute("call-1", { user: "@alice", size: 1024 });
    expect(calls).toEqual(["@alice:1024"]);
    expect(result.content).toHaveLength(2);

    const meta = JSON.parse((result.content[0] as TextContent).text) as {
      user_id: string;
      username: string;
      display_name: string;
      requested_size: number;
      width: number;
      height: number;
      mime: string;
    };
    expect(meta).toEqual({
      user_id: "42",
      username: "alice",
      display_name: "Alice A",
      requested_size: 1024,
      width: 256,
      height: 256,
      mime: "image/jpeg",
    });

    const image = result.content[1] as ImageContent;
    expect(image.type).toBe("image");
    expect(image.mimeType).toBe("image/jpeg");
    expect(image.data).toBe(Buffer.from("prepared-image/png-avatar-bytes").toString("base64"));
  });

  test("defaults size to 512", async () => {
    const resolvedSizes: number[] = [];
    const tool = createReadUserAvatarTool(makeDeps({
      resolveUserAvatar: (_reference, size) => {
        const resolved: ResolvedUserAvatar = {
          userId: "u1",
          username: "alice",
          displayName: "Alice",
          avatarUrl: `https://cdn.example/${size}.png`,
          requestedSize: size,
        };
        resolvedSizes.push(size);
        return Promise.resolve(resolved);
      },
    }));

    await tool.execute("call-2", { user: "alice" });
    expect(resolvedSizes).toEqual([512]);
  });

  test("handles unknown users gracefully without fetching", async () => {
    let fetched = false;
    const tool = createReadUserAvatarTool(makeDeps({
      resolveUserAvatar: () => Promise.resolve(null),
      fetchFn: () => {
        fetched = true;
        return Promise.resolve(response(Buffer.from("unused")));
      },
    }));

    const result = await tool.execute("call-3", { user: "<@999>" });
    expect(fetched).toBe(false);
    expect((result.content[0] as TextContent).text).toContain("not found");
    expect(result.details).toEqual({ error: true });
  });

  test("rejects invalid size gracefully", async () => {
    const tool = createReadUserAvatarTool(makeDeps());
    const result = await tool.execute("call-4", { user: "alice", size: 123 });
    expect((result.content[0] as TextContent).text).toContain("Invalid avatar size");
    expect(result.details).toEqual({ error: true });
  });

  test("handles avatar fetch failures gracefully", async () => {
    const tool = createReadUserAvatarTool(makeDeps({
      fetchFn: () => Promise.resolve({
        ok: false,
        status: 404,
        headers: new Headers(),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      }),
    }));
    const result = await tool.execute("call-5", { user: "alice" });
    expect((result.content[0] as TextContent).text).toContain("HTTP 404");
    expect(result.details).toEqual({ error: true });
  });
});
