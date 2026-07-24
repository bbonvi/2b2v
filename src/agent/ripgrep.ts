/** Run ripgrep against UTF-8 text supplied on stdin. */
export async function runRipgrep(
  args: readonly string[],
  text: string,
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted();
  const process = Bun.spawn(["rg", ...args, "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const onAbort = (): void => process.kill();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const exited = process.exited;
    const stdoutText = new Response(process.stdout).text();
    const stderrText = new Response(process.stderr).text();
    await process.stdin.write(text);
    await process.stdin.end();
    const [exitCode, stdout, stderr] = await Promise.all([exited, stdoutText, stderrText]);
    signal.throwIfAborted();
    if (exitCode === 1) return null;
    if (exitCode !== 0) throw new Error(`Invalid regex or search failure: ${stderr.trim().slice(0, 500)}`);
    return stdout;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function isBrokenPipe(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && error.code === "EPIPE";
}

/** Run one ripgrep process while lazily writing bounded UTF-8 chunks to stdin. */
export async function runRipgrepChunks(
  args: readonly string[],
  chunks: Iterable<string> | AsyncIterable<string>,
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted();
  const process = Bun.spawn(["rg", ...args, "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const onAbort = (): void => process.kill();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const exited = process.exited;
    const stdoutText = new Response(process.stdout).text();
    const stderrText = new Response(process.stderr).text();
    try {
      for await (const chunk of chunks) {
        await process.stdin.write(chunk);
      }
      await process.stdin.end();
    } catch (error) {
      if (!isBrokenPipe(error)) throw error;
    }
    const [exitCode, stdout, stderr] = await Promise.all([exited, stdoutText, stderrText]);
    signal.throwIfAborted();
    if (exitCode === 1) return null;
    if (exitCode !== 0) {
      throw new Error(`Invalid regex or search failure: ${stderr.trim().slice(0, 500)}`);
    }
    return stdout;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
