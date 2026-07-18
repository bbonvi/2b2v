const INPUT_FRAME_BYTES = 2 * 2;
const DECIMATION = 3;

/**
 * Streaming Discord PCM converter.
 *
 * Discord yields 48 kHz stereo signed PCM. Scribe and Silero share the same
 * 16 kHz mono stream, so conversion happens once before either service sees it.
 */
export class DiscordPcmToMono16k {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    const groupBytes = INPUT_FRAME_BYTES * DECIMATION;
    const groups = Math.floor(this.pending.length / groupBytes);
    if (groups === 0) return Buffer.alloc(0);
    const output = Buffer.allocUnsafe(groups * 2);
    let inputOffset = 0;
    for (let group = 0; group < groups; group += 1) {
      let sum = 0;
      for (let frame = 0; frame < DECIMATION; frame += 1) {
        sum += this.pending.readInt16LE(inputOffset);
        sum += this.pending.readInt16LE(inputOffset + 2);
        inputOffset += INPUT_FRAME_BYTES;
      }
      output.writeInt16LE(Math.round(sum / (DECIMATION * 2)), group * 2);
    }
    this.pending = this.pending.subarray(groups * groupBytes);
    return output;
  }

  reset(): void {
    this.pending = Buffer.alloc(0);
  }
}
