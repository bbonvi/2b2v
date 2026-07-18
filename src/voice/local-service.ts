import type { Logger } from "../logger.ts";

/** Lifecycle manager for a private loopback Python service. */
export class LocalVoiceService {
  private child: ReturnType<typeof Bun.spawn> | undefined;
  private ready: Promise<void> | undefined;

  constructor(
    private readonly name: string,
    private readonly command: string[],
    private readonly port: number,
    private readonly startupTimeoutMs: number,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    this.ready ??= this.startServer();
    try {
      await this.ready;
    } catch (error) {
      this.ready = undefined;
      throw error;
    }
  }

  shutdown(): void {
    this.child?.kill();
    this.child = undefined;
    this.ready = undefined;
  }

  private async startServer(): Promise<void> {
    const startedAt = Date.now();
    const child = Bun.spawn(this.command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
    });
    this.child = child;
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`${this.name} exited during startup (${child.exitCode})`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          await response.body?.cancel();
          this.log.info(`${this.name} ready`, { durationMs: Date.now() - startedAt });
          return;
        }
      } catch {
        // The loopback port remains unavailable while the model loads.
      }
      await Bun.sleep(100);
    }
    child.kill();
    throw new Error(`${this.name} did not become ready before the startup timeout`);
  }
}
