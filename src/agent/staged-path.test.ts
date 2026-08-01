import { expect, test } from "bun:test";
import { mkdtemp, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureStagedDirectory, resolveStagedPath } from "./staged-path.ts";

test("rejects staged symlinks that escape the shared root", async () => {
  const root = await mkdtemp(join(tmpdir(), "2b2v-staged-root-"));
  const directory = await ensureStagedDirectory(root, "safe");
  const file = join(directory, "inside.txt");
  await Bun.write(file, "ok");
  expect(await resolveStagedPath(root, file)).toBe(file);

  await symlink("/etc/hostname", join(directory, "escape"));
  expect(resolveStagedPath(root, join(directory, "escape"))).rejects.toThrow("outside");
});
