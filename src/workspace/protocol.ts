export type WorkspaceRequest =
  | {
      id: string;
      op: "exec";
      command: string;
      cwd?: string;
    }
  | {
      id: string;
      op: "stage";
      sourcePath: string;
      stagedRef: string;
    }
  | {
      id: string;
      op: "import";
      stagedPath: string;
      destinationPath: string;
    };

export type WorkspaceResponse =
  | {
      id: string;
      ok: true;
      op: "exec";
      exitCode: number;
      stdout: string;
      stderr: string;
    }
  | {
      id: string;
      ok: true;
      op: "stage";
      stagedRelativePath: string;
      filename: string;
      byteSize: number;
    }
  | {
      id: string;
      ok: true;
      op: "import";
      destinationPath: string;
    }
  | {
      id: string;
      ok: false;
      error: string;
    };

export function parseWorkspaceRequest(value: unknown): WorkspaceRequest {
  if (typeof value !== "object" || value === null) throw new Error("Request must be an object.");
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || input.id === "") throw new Error("id is required.");
  if (input.op === "exec") {
    if (typeof input.command !== "string" || input.command === "") throw new Error("command is required.");
    if (input.cwd !== undefined && typeof input.cwd !== "string") throw new Error("cwd must be a string.");
    return {
      id: input.id,
      op: "exec",
      command: input.command,
      ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
    };
  }
  if (input.op === "stage") {
    if (typeof input.sourcePath !== "string" || input.sourcePath === "") throw new Error("sourcePath is required.");
    if (typeof input.stagedRef !== "string" || !/^[a-z0-9-]+$/u.test(input.stagedRef)) {
      throw new Error("stagedRef is invalid.");
    }
    return { id: input.id, op: "stage", sourcePath: input.sourcePath, stagedRef: input.stagedRef };
  }
  if (input.op === "import") {
    if (typeof input.stagedPath !== "string" || input.stagedPath === "") throw new Error("stagedPath is required.");
    if (typeof input.destinationPath !== "string" || input.destinationPath === "") {
      throw new Error("destinationPath is required.");
    }
    return { id: input.id, op: "import", stagedPath: input.stagedPath, destinationPath: input.destinationPath };
  }
  throw new Error("Unknown workspace operation.");
}
