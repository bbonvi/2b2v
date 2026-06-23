import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { ImageSourceKind } from "../db/image-repository.ts";

const ReadChatImagesParams = Type.Object({
  image_ids: Type.Array(Type.Number(), {
    description: "Array of image IDs to retrieve.",
  }),
});

export interface ReadChatImagesToolDeps {
  imageReadMaxPerCall: number;
  getImageById: (id: number) => { id: number; mime: string; width: number; height: number; path: string; sourceKind?: ImageSourceKind } | null;
  readFile: (path: string) => Buffer | null;
  prepareImageForContext: (buffer: Buffer, mimeType: string) => Promise<{ data: Buffer; mime: string; width: number; height: number }>;
}

export function createReadChatImagesTool(deps: ReadChatImagesToolDeps): AgentTool {
  return {
    name: "read_chat_images",
    label: "Read Chat Images",
    description: "Retrieve stored chat images by ID.",
    parameters: ReadChatImagesParams,
    execute: async (
      _toolCallId,
      params,
    ): Promise<AgentToolResult<{ count: number } | undefined>> => {
      const p = params as { image_ids: number[] };
      const ids = p.image_ids;

      if (ids.length > deps.imageReadMaxPerCall) {
        throw new Error(
          `Too many image IDs requested (${ids.length}); maximum is ${deps.imageReadMaxPerCall} per call.`
        );
      }

      const content: (TextContent | ImageContent)[] = [];
      let count = 0;
      for (const id of ids) {
        const record = deps.getImageById(id);
        if (record === null) {
          content.push({ type: "text", text: JSON.stringify({ id, error: "not_found" }) });
          count++;
          continue;
        }

        const buf = deps.readFile(record.path);
        if (buf === null) {
          content.push({ type: "text", text: JSON.stringify({ id, error: "not_found" }) });
          count++;
          continue;
        }

        let prepared: { data: Buffer; mime: string; width: number; height: number };
        try {
          prepared = await deps.prepareImageForContext(buf, record.mime);
        } catch (error) {
          content.push({
            type: "text",
            text: JSON.stringify({
              id,
              error: "prepare_failed",
              message: error instanceof Error ? error.message : String(error),
            }),
          });
          count++;
          continue;
        }
        content.push({
          type: "text",
          text: JSON.stringify({
            id: record.id,
            width: prepared.width,
            height: prepared.height,
            source_width: record.width,
            source_height: record.height,
            source_kind: record.sourceKind ?? "image",
          }),
        });
        content.push({ type: "image", data: prepared.data.toString("base64"), mimeType: prepared.mime });
        count++;
      }

      return {
        content,
        details: { count },
      };
    },
  };
}
