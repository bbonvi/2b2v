import { describe, expect, test } from "bun:test";
import { VoiceResponseParser, type VoiceMessageDirective } from "./response-parser.ts";

describe("VoiceResponseParser", () => {
  test("streams speech while withholding message directives split across chunks", async () => {
    const speech: string[] = [];
    const messages: VoiceMessageDirective[] = [];
    const parser = new VoiceResponseParser({
      onSpeech: (text) => { speech.push(text); },
      onMessage: (message) => { messages.push(message); },
      onIgnore: () => {},
    });
    await parser.push("Understood. <mes");
    await parser.push('sage channel_id="c1" reply_to="m1" resolves_instruction="vi1">Done.</message> I will stay.');
    const result = await parser.finish();
    expect(speech.join(" ")).toBe("Understood. I will stay.");
    expect(messages).toEqual([{
      channelId: "c1",
      replyTo: "m1",
      resolvesInstruction: "vi1",
      text: "Done.",
    }]);
    expect(result.malformed).toBe(false);
    expect(result.plannedSpeech).toBe("Understood. I will stay.");
  });

  test("fails closed on malformed reserved markup", async () => {
    const speech: string[] = [];
    const parser = new VoiceResponseParser({
      onSpeech: (text) => { speech.push(text); },
      onMessage: () => {},
      onIgnore: () => {},
    });
    await parser.push("<message channel_id=\"c1\">private text");
    const result = await parser.finish();
    expect(result.malformed).toBe(true);
    expect(speech).toEqual([]);
  });

  test("supports instruction-aware ignore", async () => {
    let ignored = "";
    const parser = new VoiceResponseParser({
      onSpeech: () => {},
      onMessage: () => {},
      onIgnore: (id) => { ignored = id ?? ""; },
    });
    await parser.push('<ignore instruction_id="vi2">');
    expect((await parser.finish()).ignored).toBe(true);
    expect(ignored).toBe("vi2");
  });

  test("commits trailing sentence punctuation after a short stream idle", async () => {
    const speech: string[] = [];
    const parser = new VoiceResponseParser({
      onSpeech: (text) => { speech.push(text); },
      onMessage: () => {},
      onIgnore: () => {},
    });

    await parser.push("Короткий ответ.");
    await Bun.sleep(80);

    expect(speech).toEqual(["Короткий ответ."]);
    expect((await parser.finish()).plannedSpeech).toBe("Короткий ответ.");
  });
});
