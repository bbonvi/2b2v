import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, type Database } from "../db/database.ts";
import { getStagedAsset } from "../db/staged-asset-repository.ts";
import { stageGeneratedImage } from "./generated-image-staging.ts";

const temporaryDirectories: string[] = [];
const databases: Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("generated image staging", () => {
  test("persists a generated image as an unresolved staged asset", async () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    const stagingRoot = mkdtempSync(join(tmpdir(), "2b2v-generated-stage-"));
    temporaryDirectories.push(stagingRoot);

    const staged = await stageGeneratedImage({
      db,
      stagingRoot,
      ownerGuildId: "guild-1",
      ownerChannelId: "channel-1",
      ref: "generated_test",
      attachment: {
        buffer: Buffer.from("image-bytes"),
        filename: "result.webp",
        contentType: "image/webp",
      },
    });

    expect(readFileSync(staged.storagePath).toString()).toBe("image-bytes");
    expect(staged.workspacePath).toBe("/workspace/staged-assets/generated_test/result.webp");
    expect(getStagedAsset(db, "generated_test")).toMatchObject({
      ref: "generated_test",
      ownerGuildId: "guild-1",
      ownerChannelId: "channel-1",
      filename: "result.webp",
      contentType: "image/webp",
      storagePath: staged.storagePath,
    });
    expect(getStagedAsset(db, "generated_test")?.deliveredMessageId).toBeUndefined();
  });
});
