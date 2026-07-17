export interface VoiceMessageDirective {
  channelId?: string;
  replyTo?: string;
  resolvesInstruction?: string;
  text: string;
}

export interface VoiceResponseParserCallbacks {
  onSpeech: (text: string) => void | Promise<void>;
  onMessage: (message: VoiceMessageDirective) => void | Promise<void>;
  onIgnore: (instructionId?: string) => void | Promise<void>;
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([a-z_][a-z0-9_-]*)\s*=\s*"([^"]*)"/gi;
  for (const match of tag.matchAll(pattern)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) result[key.toLowerCase()] = value;
  }
  return result;
}

function phraseBoundary(text: string): number {
  let best = -1;
  for (const match of text.matchAll(/[.!?…](?:["')\]]*)\s+/g)) {
    best = match.index + match[0].length;
  }
  if (best >= 0) return best;
  if (text.length < 180) return -1;
  const comma = text.lastIndexOf(" ", 160);
  return comma >= 60 ? comma + 1 : 160;
}

/**
 * Incrementally separates spoken text from private Discord message directives.
 * Incomplete or malformed reserved tags are held and never spoken.
 */
export class VoiceResponseParser {
  private buffer = "";
  private ignored = false;
  private readonly plannedSpeech: string[] = [];

  constructor(private readonly callbacks: VoiceResponseParserCallbacks) {}

  async push(delta: string): Promise<void> {
    if (delta === "" || this.ignored) return;
    this.buffer += delta;
    await this.drain(false);
  }

  async finish(): Promise<{ plannedSpeech: string; ignored: boolean; malformed: boolean }> {
    if (this.ignored) return { plannedSpeech: "", ignored: true, malformed: false };
    const malformed = await this.drain(true);
    return { plannedSpeech: this.plannedSpeech.join(" ").trim(), ignored: this.ignored, malformed };
  }

  private async drain(final: boolean): Promise<boolean> {
    let malformed = false;
    for (;;) {
      const lower = this.buffer.toLowerCase();
      const tagStart = this.buffer.indexOf("<");
      if (tagStart === -1) {
        const boundary = final ? this.buffer.length : phraseBoundary(this.buffer);
        if (boundary <= 0) return malformed;
        await this.emitSpeech(this.buffer.slice(0, boundary));
        this.buffer = this.buffer.slice(boundary);
        continue;
      }

      if (tagStart > 0) {
        const plain = this.buffer.slice(0, tagStart);
        const boundary = final ? plain.length : phraseBoundary(plain);
        if (boundary <= 0) return malformed;
        await this.emitSpeech(plain.slice(0, boundary));
        this.buffer = plain.slice(boundary) + this.buffer.slice(tagStart);
        continue;
      }

      if (lower.startsWith("<voice>")) {
        this.buffer = this.buffer.slice("<voice>".length);
        continue;
      }
      if (lower.startsWith("</voice>")) {
        this.buffer = this.buffer.slice("</voice>".length);
        continue;
      }
      if (lower.startsWith("<message")) {
        const openEnd = this.buffer.indexOf(">");
        if (openEnd === -1) return final;
        const closeStart = lower.indexOf("</message>", openEnd + 1);
        if (closeStart === -1) return final;
        const attrs = attributes(this.buffer.slice(0, openEnd + 1));
        const text = this.buffer.slice(openEnd + 1, closeStart).trim();
        if (text !== "") {
          await this.callbacks.onMessage({
            text,
            ...(attrs.channel_id !== undefined ? { channelId: attrs.channel_id } : {}),
            ...(attrs.reply_to !== undefined ? { replyTo: attrs.reply_to } : {}),
            ...(attrs.resolves_instruction !== undefined
              ? { resolvesInstruction: attrs.resolves_instruction }
              : {}),
          });
        }
        this.buffer = this.buffer.slice(closeStart + "</message>".length);
        continue;
      }
      if (lower.startsWith("<ignore")) {
        const end = this.buffer.indexOf(">");
        if (end === -1) return final;
        const attrs = attributes(this.buffer.slice(0, end + 1));
        await this.callbacks.onIgnore(attrs.instruction_id);
        this.ignored = true;
        this.buffer = "";
        return malformed;
      }

      if (!final && ["<voice", "</voice", "<message", "<ignore"].some((prefix) => prefix.startsWith(lower))) {
        return malformed;
      }
      malformed = true;
      this.buffer = "";
      return malformed;
    }
  }

  private async emitSpeech(text: string): Promise<void> {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized !== "") {
      this.plannedSpeech.push(normalized);
      await this.callbacks.onSpeech(normalized);
    }
  }
}
