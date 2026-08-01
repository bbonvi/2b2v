import { dirname, isAbsolute, join, relative } from "node:path";
import { mkdir, realpath, unlink } from "node:fs/promises";

/** Resolve one shared staged file without following a workspace symlink outside the mounted root. */
export async function resolveStagedPath(root: string, path: string): Promise<string> {
  const [resolvedRoot, resolvedPath] = await Promise.all([realpath(root), realpath(path)]);
  assertInside(resolvedRoot, resolvedPath);
  return resolvedPath;
}

/** Create and validate a bot-owned directory inside the shared staged root. */
export async function ensureStagedDirectory(root: string, name: string): Promise<string> {
  if (name === "" || isAbsolute(name) || name.includes("/") || name.includes("\\")) {
    throw new Error("Invalid staged directory name.");
  }
  await mkdir(root, { recursive: true });
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  const [resolvedRoot, resolvedDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  assertInside(resolvedRoot, resolvedDirectory);
  return resolvedDirectory;
}

/** Delete a staged entry only when its parent directory still resolves inside the shared root. */
export async function unlinkStagedPath(root: string, path: string): Promise<void> {
  const [resolvedRoot, resolvedParent] = await Promise.all([realpath(root), realpath(dirname(path))]);
  assertInside(resolvedRoot, resolvedParent);
  await unlink(path);
}

function assertInside(root: string, path: string): void {
  const child = relative(root, path);
  if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return;
  throw new Error("Staged path resolves outside the shared staging root.");
}
