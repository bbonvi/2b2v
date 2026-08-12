import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { Database } from "../db/database.ts";
import { createStagedAsset } from "../db/staged-asset-repository.ts";
import { ensureStagedDirectory } from "./staged-path.ts";

const STAGED_ASSET_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface StagedGeneratedImage {
  assetRef: string;
  workspacePath: string;
  storagePath: string;
  filename: string;
  contentType: string;
  byteSize: number;
}

interface StageableGeneratedImage {
  buffer: Buffer;
  filename: string;
  contentType: string;
}

/** Persist a completed image before an actor decides whether and where to send it. */
export async function stageGeneratedImage(input: {
  db: Database;
  stagingRoot: string;
  ownerGuildId: string;
  ownerChannelId: string;
  attachment: StageableGeneratedImage;
  ref?: string;
  jobId?: string;
}): Promise<StagedGeneratedImage> {
  const assetRef = input.ref ?? `generated_${randomUUID().replaceAll("-", "")}`;
  const directory = await ensureStagedDirectory(input.stagingRoot, assetRef);
  const filename = basename(input.attachment.filename);
  const storagePath = join(directory, filename);
  await Bun.write(storagePath, input.attachment.buffer);
  const now = Date.now();
  createStagedAsset(input.db, {
    ref: assetRef,
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    ownerGuildId: input.ownerGuildId,
    ownerChannelId: input.ownerChannelId,
    filename,
    contentType: input.attachment.contentType,
    storagePath,
    createdAt: now,
    expiresAt: now + STAGED_ASSET_TTL_MS,
  });
  return {
    assetRef,
    workspacePath: `/workspace/staged-assets/${assetRef}/${filename}`,
    storagePath,
    filename,
    contentType: input.attachment.contentType,
    byteSize: input.attachment.buffer.length,
  };
}
