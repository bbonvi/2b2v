import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

const ReadChatImagesParams = Type.Object({
  image_ids: Type.Array(Type.Number(), {
    description: "Array of image IDs to retrieve.",
  }),
});

export interface ReadChatImagesToolDeps {
  imageReadMaxPerCall: number;
  getImageById: (id: number) => { id: number; mime: string; width: number; height: number; path: string } | null;
  readFile: (path: string) => Buffer | null;
}

export function createReadChatImagesTool(deps: ReadChatImagesToolDeps): AgentTool {
  return {
    name: "read_chat_images",
    label: "Read Chat Images",
    description:
      "Retrieve stored images by their IDs from chat history. Returns image data with metadata. Use this to view images referenced by image_ids in chat history.",
    parameters: ReadChatImagesParams,
    execute: (
      _toolCallId,
      params,
    ): Promise<AgentToolResult<{ count: number } | undefined>> => {
      const p = params as { image_ids: number[] };
      const ids = p.image_ids;

      if (ids.length > deps.imageReadMaxPerCall) {
        throw new Error(
          `Too many image IDs requested (${ids.length}). Maximum is ${deps.imageReadMaxPerCall} per call.`
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

        content.push({ type: "text", text: JSON.stringify({ id: record.id, width: record.width, height: record.height }) });
        content.push({ type: "image", data: buf.toString("base64"), mimeType: record.mime });
        count++;
      }

      return Promise.resolve({
        content,
        details: { count },
      });
    },
  };
}
