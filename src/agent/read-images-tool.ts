import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

const ReadImagesParams = Type.Object({
  image_ids: Type.Array(Type.Number(), {
    description: "Array of image IDs to retrieve.",
  }),
});

export interface ReadImagesToolDeps {
  imageReadMaxPerCall: number;
  getImageById: (id: number) => { id: number; mime: string; width: number; height: number; path: string } | null;
  readFile: (path: string) => Buffer | null;
}

type SuccessEntry = { id: number; mime: string; width: number; height: number; data_base64: string };
type ErrorEntry = { id: number; error: "not_found" };
type ResultEntry = SuccessEntry | ErrorEntry;

export function createReadImagesTool(deps: ReadImagesToolDeps): AgentTool {
  return {
    name: "read_images",
    label: "Read Images",
    description:
      "Retrieve stored images by their IDs. Returns base64-encoded image data with metadata. Use this to view images referenced by image_ids in chat history.",
    parameters: ReadImagesParams,
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

      const results: ResultEntry[] = [];
      for (const id of ids) {
        const record = deps.getImageById(id);
        if (record === null) {
          results.push({ id, error: "not_found" });
          continue;
        }

        const buf = deps.readFile(record.path);
        if (buf === null) {
          results.push({ id, error: "not_found" });
          continue;
        }

        results.push({
          id: record.id,
          mime: record.mime,
          width: record.width,
          height: record.height,
          data_base64: buf.toString("base64"),
        });
      }

      return Promise.resolve({
        content: [{ type: "text", text: JSON.stringify(results) }],
        details: { count: results.length },
      });
    },
  };
}
