import { expect, test } from "bun:test";
import { parseWorkspaceRequest } from "./protocol.ts";

test("parses workspace operations and rejects unsafe staged refs", () => {
  expect(parseWorkspaceRequest({ id: "1", op: "exec", command: "pwd", cwd: "src" })).toEqual({
    id: "1",
    op: "exec",
    command: "pwd",
    cwd: "src",
  });
  expect(parseWorkspaceRequest({ id: "2", op: "stage", sourcePath: "a.png", stagedRef: "file-ab12" })).toEqual({
    id: "2",
    op: "stage",
    sourcePath: "a.png",
    stagedRef: "file-ab12",
  });
  expect(parseWorkspaceRequest({ id: "3", op: "import", stagedPath: "transfer/a", destinationPath: "imports/a" })).toEqual({
    id: "3",
    op: "import",
    stagedPath: "transfer/a",
    destinationPath: "imports/a",
  });
  expect(() => parseWorkspaceRequest({ id: "2", op: "stage", sourcePath: "a", stagedRef: "../escape" })).toThrow();
});
