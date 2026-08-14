import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type Database } from "../db/database.ts";
import {
  createStagedAsset,
  getStagedAsset,
  reconcileStagedAsset,
} from "../db/staged-asset-repository.ts";
import { cleanExpiredStagedAssets } from "./staged-asset-cleanup.ts";
import { ensureStagedDirectory } from "./staged-path.ts";

const temporaryDirectories: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("staged asset cleanup", () => {
  test("keeps delivered assets until their expiry time", async () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const stagingRoot = mkdtempSync(join(tmpdir(), "2b2v-staged-cleanup-"));
    temporaryDirectories.push(stagingRoot);
    const now = Date.now();

    const expiredDirectory = await ensureStagedDirectory(stagingRoot, "expired_delivered");
    const expiredPath = join(expiredDirectory, "expired.webp");
    await Bun.write(expiredPath, "expired");
    createStagedAsset(db, {
      ref: "expired_delivered",
      ownerGuildId: "g1",
      ownerChannelId: "c1",
      filename: "expired.webp",
      contentType: "image/webp",
      storagePath: expiredPath,
      createdAt: now - 1_000,
      expiresAt: now,
    });
    reconcileStagedAsset(db, {
      ref: "expired_delivered",
      deliveredMessageId: "message-1",
    });

    const reusableDirectory = await ensureStagedDirectory(stagingRoot, "reusable_delivered");
    const reusablePath = join(reusableDirectory, "reusable.webp");
    await Bun.write(reusablePath, "reusable");
    createStagedAsset(db, {
      ref: "reusable_delivered",
      ownerGuildId: "g1",
      ownerChannelId: "c1",
      filename: "reusable.webp",
      contentType: "image/webp",
      storagePath: reusablePath,
      createdAt: now - 1_000,
      expiresAt: now + 1,
    });
    reconcileStagedAsset(db, {
      ref: "reusable_delivered",
      deliveredMessageId: "message-2",
    });

    const deleted = await cleanExpiredStagedAssets({
      db,
      agentJobs: { markExpired: () => undefined },
      stagingRoot,
      now,
    });

    expect(deleted).toBe(1);
    expect(getStagedAsset(db, "expired_delivered")).toBeNull();
    expect(await Bun.file(expiredPath).exists()).toBe(false);
    expect(getStagedAsset(db, "reusable_delivered")).not.toBeNull();
    expect(await Bun.file(reusablePath).exists()).toBe(true);
  });
});
