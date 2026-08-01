import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { rm } from "node:fs/promises";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "../db/database.ts";
import { createStagedAsset } from "../db/staged-asset-repository.ts";
import type { WorkspaceClient } from "../workspace/client.ts";
import { AssetRefSchema, parseAssetRef, type AssetRef } from "./asset-id.ts";
import { ensureStagedDirectory, resolveStagedPath } from "./staged-path.ts";

const ExecParams = Type.Object({
  command: Type.String({ minLength: 1, description: "Bash command to run as root." }),
  cwd: Type.Optional(Type.String({ minLength: 1, description: "Absolute path or path relative to /workspace." })),
});
const ExportParams = Type.Object({
  asset_id: AssetRefSchema,
  path: Type.Optional(Type.String({ minLength: 1, description: "Destination path. Defaults to /workspace/imports/<filename>." })),
});
const StageParams = Type.Object({
  path: Type.String({ minLength: 1, description: "File path inside the workspace." }),
});

export interface WorkspaceAsset {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

export function createWorkspaceTools(input: {
  db: Database;
  client: WorkspaceClient;
  stagingRoot: string;
  guildId: string;
  channelId: string;
  loadAsset: (assetId: AssetRef, signal?: AbortSignal) => Promise<WorkspaceAsset>;
}): AgentTool[] {
  const execTool: AgentTool = {
    name: "workspace_exec",
    label: "workspace_exec",
    description: "Run an unrestricted Bash command as root in the persistent private workspace.",
    parameters: ExecParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      const request = params as { command: string; cwd?: string };
      const result = await input.client.exec(request.command, { cwd: request.cwd, signal });
      const output = [
        `Exit code: ${result.exitCode}`,
        result.stdout !== "" ? `stdout:\n${bounded(result.stdout)}` : "",
        result.stderr !== "" ? `stderr:\n${bounded(result.stderr)}` : "",
      ].filter((value) => value !== "").join("\n");
      return {
        content: [{ type: "text", text: output }],
        details: { exitCode: result.exitCode },
      };
    },
  };

  const exportTool: AgentTool = {
    name: "export_asset_to_workspace",
    label: "export_asset_to_workspace",
    description: "Copy a Discord or staged asset into the persistent workspace.",
    parameters: ExportParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      const request = params as { asset_id: unknown; path?: string };
      const assetId = parseAssetRef(request.asset_id);
      if (assetId === null) throw new Error("asset_id is invalid.");
      const asset = await input.loadAsset(assetId, signal);
      const filename = basename(asset.filename);
      const transferRef = `.transfer-${randomUUID()}`;
      const relativePath = join(transferRef, filename);
      const transferDirectory = await ensureStagedDirectory(input.stagingRoot, transferRef);
      const botPath = join(transferDirectory, filename);
      await Bun.write(botPath, asset.buffer);
      try {
        const destination = request.path ?? join("/workspace/imports", filename);
        const result = await input.client.importFile(relativePath, destination, signal);
        return {
          content: [{ type: "text", text: `Copied asset ${String(assetId)} to ${result.destinationPath}` }],
          details: { assetId, path: result.destinationPath, contentType: asset.contentType },
        };
      } finally {
        await rm(dirname(botPath), { force: true, recursive: true });
      }
    },
  };

  const stageTool: AgentTool = {
    name: "stage_workspace_file",
    label: "stage_workspace_file",
    description: "Make one workspace file available as a staged asset for reading, image references, or Discord delivery.",
    parameters: StageParams,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      const request = params as { path: string };
      const ref = `workspace-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const result = await input.client.stage(request.path, ref, signal);
      const storagePath = join(input.stagingRoot, result.stagedRelativePath);
      const safeStoragePath = await resolveStagedPath(input.stagingRoot, storagePath);
      const detectedContentType = Bun.file(safeStoragePath).type;
      const contentType = detectedContentType !== "" ? detectedContentType : "application/octet-stream";
      const now = Date.now();
      createStagedAsset(input.db, {
        ref,
        ownerGuildId: input.guildId,
        ownerChannelId: input.channelId,
        filename: result.filename,
        contentType,
        storagePath: safeStoragePath,
        createdAt: now,
        // Legacy column only. Cleanup uses the file mtime.
        expiresAt: now + 7 * 24 * 60 * 60 * 1000,
      });
      return {
        content: [{ type: "text", text: `Staged ${request.path} as ${ref} (${result.byteSize.toLocaleString("en-US")} bytes).` }],
        details: { assetRef: ref, filename: result.filename, byteSize: result.byteSize, contentType },
      };
    },
  };

  return [execTool, exportTool, stageTool];
}

function bounded(value: string): string {
  const maxCharacters = 40_000;
  return value.length <= maxCharacters
    ? value
    : `${value.slice(0, maxCharacters)}\n[Output truncated. Write large output to a workspace file and inspect a range.]`;
}
