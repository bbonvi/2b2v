import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { parseWorkspaceRequest, type WorkspaceRequest, type WorkspaceResponse } from "./protocol.ts";

const socketPath = process.env.WORKSPACE_SOCKET_PATH ?? "/run/2b2v/workspace.sock";
const workspaceRoot = process.env.WORKSPACE_ROOT ?? "/workspace";
const stagingRoot = process.env.WORKSPACE_STAGING_DIR ?? join(workspaceRoot, "staged-assets");
const MAX_REQUEST_BYTES = 1024 * 1024;

await mkdir(workspaceRoot, { recursive: true });
await mkdir(stagingRoot, { recursive: true });
await mkdir(dirname(socketPath), { recursive: true });
await rm(socketPath, { force: true });

async function handleRequest(request: WorkspaceRequest, socket: Socket): Promise<WorkspaceResponse> {
  try {
    if (request.op === "exec") {
      const cwd = request.cwd === undefined
        ? workspaceRoot
        : isAbsolute(request.cwd) ? request.cwd : resolve(workspaceRoot, request.cwd);
      const child = Bun.spawn(["bash", "-lc", request.command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stop = (): void => { child.kill(); };
      socket.once("close", stop);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).finally(() => socket.removeListener("close", stop));
      return { id: request.id, ok: true, op: "exec", exitCode, stdout, stderr };
    }

    if (request.op === "import") {
      const stagedPath = isAbsolute(request.stagedPath)
        ? request.stagedPath
        : resolve(stagingRoot, request.stagedPath);
      const destinationPath = isAbsolute(request.destinationPath)
        ? request.destinationPath
        : resolve(workspaceRoot, request.destinationPath);
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(stagedPath, destinationPath);
      return { id: request.id, ok: true, op: "import", destinationPath };
    }

    const sourcePath = isAbsolute(request.sourcePath)
      ? request.sourcePath
      : resolve(workspaceRoot, request.sourcePath);
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) throw new Error("Only regular files can be staged.");
    const filename = basename(sourcePath);
    const destinationDir = join(stagingRoot, request.stagedRef);
    await mkdir(destinationDir, { recursive: true });
    const stagedPath = join(destinationDir, filename);
    await copyFile(sourcePath, stagedPath);
    return {
      id: request.id,
      ok: true,
      op: "stage",
      stagedRelativePath: relative(stagingRoot, stagedPath),
      filename,
      byteSize: sourceStat.size,
    };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function serveConnection(socket: Socket): void {
  socket.setEncoding("utf8");
  let body = "";
  socket.on("data", (chunk: string) => {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      socket.end(`${JSON.stringify({ id: "", ok: false, error: "Request exceeded 1 MiB." })}\n`);
      return;
    }
    const newline = body.indexOf("\n");
    if (newline < 0) return;
    socket.pause();
    let request: WorkspaceRequest;
    try {
      request = parseWorkspaceRequest(JSON.parse(body.slice(0, newline)));
    } catch (error) {
      socket.end(`${JSON.stringify({
        id: "",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })}\n`);
      return;
    }
    void handleRequest(request, socket).then((response) => socket.end(`${JSON.stringify(response)}\n`));
  });
}

const server = createServer(serveConnection);
server.listen(socketPath);
process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
