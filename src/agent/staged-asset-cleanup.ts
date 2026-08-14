import type { Database } from "../db/database.ts";
import { deleteStagedAsset, listStagedAssets } from "../db/staged-asset-repository.ts";
import type { AgentJobStore } from "./job-runtime.ts";
import { resolveStagedPath, unlinkStagedPath } from "./staged-path.ts";

/** Delete staged files after their shared seven-day reuse window. */
export async function cleanExpiredStagedAssets(input: {
  db: Database;
  agentJobs: Pick<AgentJobStore, "markExpired">;
  stagingRoot: string;
  now?: number;
}): Promise<number> {
  const now = input.now ?? Date.now();
  let deleted = 0;
  for (const staged of listStagedAssets(input.db, {
    expiresAtOrBefore: now,
    limit: 500,
    oldestFirst: true,
  })) {
    const safePath = await resolveStagedPath(input.stagingRoot, staged.storagePath).catch(() => null);
    if (staged.jobId !== undefined) input.agentJobs.markExpired(staged.jobId, now);
    if (safePath !== null) await unlinkStagedPath(input.stagingRoot, staged.storagePath).catch(() => {});
    deleteStagedAsset(input.db, staged.ref);
    deleted++;
  }
  return deleted;
}
