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
