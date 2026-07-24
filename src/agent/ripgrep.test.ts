import { expect, test } from "bun:test";
import { runRipgrepChunks } from "./ripgrep.ts";

test("accepts an early successful ripgrep exit while large stdin remains", async () => {
  const chunk = `first match\n${"x".repeat(100_000)}\n`;
  const output = await runRipgrepChunks([
    "--json",
    "--text",
    "--color=never",
    "--max-count=1",
    "--regexp",
    ".",
  ], Array.from({ length: 100 }, () => chunk), AbortSignal.timeout(5000));

  expect(output).toContain('"type":"match"');
});
