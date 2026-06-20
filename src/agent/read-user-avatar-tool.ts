import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

const AVATAR_SIZE_VALUES = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096] as const;
export type AvatarSize = typeof AVATAR_SIZE_VALUES[number];

const ReadUserAvatarParams = Type.Object({
  user: Type.String({
    minLength: 1,
    description:
      "Discord username, @username, raw user mention such as <@123>, or user ID. Resolves in the current guild only; DMs are unsupported.",
  }),
  size: Type.Optional(Type.Union(AVATAR_SIZE_VALUES.map((value) => Type.Literal(value)), {
    description: "Optional Discord CDN avatar size. Defaults to 512.",
  })),
});

export interface ResolvedUserAvatar {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  requestedSize: AvatarSize;
}

export interface ReadUserAvatarToolDeps {
  resolveUserAvatar: (reference: string, size: AvatarSize) => Promise<ResolvedUserAvatar | null>;
  fetchFn: (url: string) => Promise<{ ok: boolean; status?: number; headers?: Headers; arrayBuffer(): Promise<ArrayBuffer> }>;
  prepareImageForContext: (buffer: Buffer, mimeType: string) => Promise<{ data: Buffer; mime: string; width: number; height: number }>;
}

type ReadUserAvatarDetails =
  | {
    userId: string;
    username: string;
    displayName: string;
    requestedSize: AvatarSize;
    width: number;
    height: number;
    mime: string;
  }
  | { error: boolean };

/** Create a read-only tool that fetches a guild member's current display avatar without persisting it. */
export function createReadUserAvatarTool(deps: ReadUserAvatarToolDeps): AgentTool {
  return {
    name: "read_user_avatar",
    label: "read_user_avatar",
    description:
      "Read a guild member's current Discord display avatar/profile picture as image context without storing it. Accepts username, @username, raw mention, or user ID. Current-guild only; DMs are unsupported.",
    parameters: ReadUserAvatarParams,

    async execute(_toolCallId: string, params: unknown): Promise<AgentToolResult<ReadUserAvatarDetails>> {
      const p = params as { user?: string; size?: number };
      const reference = typeof p.user === "string" ? p.user.trim() : "";
      if (reference === "") {
        return {
          content: [{ type: "text", text: "User is required." }],
          details: { error: true },
        };
      }

      const size = normalizeAvatarSize(p.size);
      if (size === undefined) {
        return {
          content: [{ type: "text", text: `Invalid avatar size. Use one of: ${AVATAR_SIZE_VALUES.join(", ")}.` }],
          details: { error: true },
        };
      }

      const user = await deps.resolveUserAvatar(reference, size);
      if (user === null) {
        return {
          content: [{ type: "text", text: `User '${reference}' not found in this guild. DMs are not supported.` }],
          details: { error: true },
        };
      }

      let response: Awaited<ReturnType<ReadUserAvatarToolDeps["fetchFn"]>>;
      try {
        response = await deps.fetchFn(user.avatarUrl);
      } catch (error) {
        return {
          content: [{ type: "text", text: `Avatar fetch failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }

      if (!response.ok) {
        return {
          content: [{ type: "text", text: `Avatar fetch failed with HTTP ${response.status ?? "unknown"}.` }],
          details: { error: true },
        };
      }

      let prepared: { data: Buffer; mime: string; width: number; height: number };
      const mimeType = response.headers?.get("content-type")?.split(";")[0]?.trim() ?? "image/png";
      try {
        const buffer = Buffer.from(await response.arrayBuffer());
        prepared = await deps.prepareImageForContext(buffer, mimeType);
      } catch (error) {
        return {
          content: [{ type: "text", text: `Avatar image preparation failed: ${error instanceof Error ? error.message : String(error)}` }],
          details: { error: true },
        };
      }

      const metadata = {
        user_id: user.userId,
        username: user.username,
        display_name: user.displayName,
        requested_size: user.requestedSize,
        width: prepared.width,
        height: prepared.height,
        mime: prepared.mime,
      };
      const content: (TextContent | ImageContent)[] = [
        { type: "text", text: JSON.stringify(metadata) },
        { type: "image", data: prepared.data.toString("base64"), mimeType: prepared.mime },
      ];
      return {
        content,
        details: {
          userId: user.userId,
          username: user.username,
          displayName: user.displayName,
          requestedSize: user.requestedSize,
          width: prepared.width,
          height: prepared.height,
          mime: prepared.mime,
        },
      };
    },
  };
}

function normalizeAvatarSize(size: number | undefined): AvatarSize | undefined {
  if (size === undefined) return 512;
  if (AVATAR_SIZE_VALUES.includes(size as AvatarSize)) return size as AvatarSize;
  return undefined;
}
