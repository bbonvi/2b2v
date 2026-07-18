import type { VoiceSttConfig } from "../config/types.ts";
import type { Logger } from "../logger.ts";
import { LocalVoiceService } from "./local-service.ts";

interface VadResponse {
  probabilities: number[];
}

function parseVadResponse(value: unknown): VadResponse | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const probabilities = (value as Record<string, unknown>).probabilities;
  if (!Array.isArray(probabilities)) return undefined;
  const parsed: number[] = [];
  for (const entry of probabilities as unknown[]) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) return undefined;
    parsed.push(entry);
  }
  return { probabilities: parsed };
}

/** Stateful Silero VAD client backed by a lightweight local ONNX service. */
export class SileroVadClient {
  private readonly service: LocalVoiceService;

  constructor(
    private readonly config: VoiceSttConfig,
    log: Logger,
  ) {
    this.service = new LocalVoiceService(
      "Silero voice detection server",
      [
        config.vadCommand,
        "--host", "127.0.0.1",
        "--port", String(config.vadServerPort),
        "--model", config.vadModelPath,
      ],
      config.vadServerPort,
      Math.min(config.timeoutMs, 20_000),
      log,
    );
  }

  async start(): Promise<void> {
    await this.service.start();
  }

  async score(streamId: string, pcm: Buffer, signal?: AbortSignal): Promise<number[]> {
    await this.start();
    const response = await fetch(`http://127.0.0.1:${this.config.vadServerPort}/inference`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Stream-ID": streamId,
      },
      body: Uint8Array.from(pcm),
      signal,
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const detail = typeof body === "object" && body !== null
        && typeof (body as Record<string, unknown>).error === "string"
        ? (body as Record<string, unknown>).error
        : "Unknown Silero VAD error";
      throw new Error(`Local voice detection failed (${response.status}): ${String(detail)}`);
    }
    const result = parseVadResponse(body);
    if (result === undefined) throw new Error("Local voice detection returned an invalid response");
    return result.probabilities;
  }

  async reset(streamId: string): Promise<void> {
    try {
      await fetch(`http://127.0.0.1:${this.config.vadServerPort}/reset`, {
        method: "POST",
        headers: { "X-Stream-ID": streamId },
        signal: AbortSignal.timeout(1_000),
      });
    } catch {
      // Process shutdown also clears state; reset is only a bounded leak guard.
    }
  }

  shutdown(): void {
    this.service.shutdown();
  }
}
