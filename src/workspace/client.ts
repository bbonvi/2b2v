import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import type { WorkspaceRequest, WorkspaceResponse } from "./protocol.ts";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class WorkspaceClient {
  constructor(private readonly socketPath: string) {}

  async exec(
    command: string,
    options: { cwd?: string; signal?: AbortSignal } = {},
  ): Promise<Extract<WorkspaceResponse, { ok: true; op: "exec" }>> {
    const response = await this.request({
      id: randomUUID(),
      op: "exec",
      command,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    }, options.signal);
    if (!response.ok) throw new Error(response.error);
    if (response.op !== "exec") throw new Error("Workspace returned the wrong response type.");
    return response;
  }

  async stage(
    sourcePath: string,
    stagedRef: string,
    signal?: AbortSignal,
  ): Promise<Extract<WorkspaceResponse, { ok: true; op: "stage" }>> {
    const response = await this.request({ id: randomUUID(), op: "stage", sourcePath, stagedRef }, signal);
    if (!response.ok) throw new Error(response.error);
    if (response.op !== "stage") throw new Error("Workspace returned the wrong response type.");
    return response;
  }

  async importFile(
    stagedPath: string,
    destinationPath: string,
    signal?: AbortSignal,
  ): Promise<Extract<WorkspaceResponse, { ok: true; op: "import" }>> {
    const response = await this.request({
      id: randomUUID(),
      op: "import",
      stagedPath,
      destinationPath,
    }, signal);
    if (!response.ok) throw new Error(response.error);
    if (response.op !== "import") throw new Error("Workspace returned the wrong response type.");
    return response;
  }

  private async request(request: WorkspaceRequest, signal?: AbortSignal): Promise<WorkspaceResponse> {
    if (signal?.aborted === true) throw abortError(signal);
    return await new Promise<WorkspaceResponse>((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let settled = false;
      let body = "";
      const finish = (error?: unknown, response?: WorkspaceResponse): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error !== undefined) reject(asError(error));
        else if (response !== undefined) resolve(response);
      };
      const onAbort = (): void => finish(signal === undefined ? new Error("Workspace request aborted.") : abortError(signal));
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk: string) => {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
          finish(new Error("Workspace response exceeded 4 MiB."));
          return;
        }
        const newline = body.indexOf("\n");
        if (newline < 0) return;
        try {
          finish(undefined, JSON.parse(body.slice(0, newline)) as WorkspaceResponse);
        } catch {
          finish(new Error("Workspace returned invalid JSON."));
        }
      });
      socket.on("error", finish);
      socket.on("end", () => {
        if (!settled) finish(new Error("Workspace closed the connection without a response."));
      });
    });
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Workspace request aborted.");
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : "Workspace request failed.");
}
