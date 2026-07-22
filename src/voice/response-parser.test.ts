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

  test("withholds complete and malformed private thoughts", async () => {
    const speech: string[] = [];
    const parser = new VoiceResponseParser({
      onSpeech: (text) => { speech.push(text); },
      onMessage: () => {},
      onIgnore: () => {},
    });
    await parser.push("<thoughts>private ");
    await parser.push("reaction</thoughts>Spoken answer.");
    expect(await parser.finish()).toEqual({
      plannedSpeech: "Spoken answer.",
      ignored: false,
      malformed: false,
    });
    expect(speech).toEqual(["Spoken answer."]);

    const malformedParser = new VoiceResponseParser({
      onSpeech: (text) => { speech.push(text); },
      onMessage: () => {},
      onIgnore: () => {},
    });
    await malformedParser.push("<thoughts>never speak this");
    expect((await malformedParser.finish()).malformed).toBe(true);
    expect(speech).toEqual(["Spoken answer."]);
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

  test("strips yield markers and reports natural interruption boundaries", async () => {
    const speech: string[] = [];
    const boundaries: number[] = [];
    const parser = new VoiceResponseParser({
      onSpeech: (text) => { speech.push(text); },
      onYieldBoundary: (offset) => { boundaries.push(offset); },
      onMessage: () => {},
      onIgnore: () => {},
    });

    await parser.push("I checked it. <");
    await parser.push("|> The restart is at seven thirty, not seven.<|> Optional detail.");
    const result = await parser.finish();

    expect(speech).toEqual([
      "I checked it.",
      "The restart is at seven thirty, not seven.",
      "Optional detail.",
    ]);
    expect(boundaries).toEqual([
      "I checked it.".length,
      "I checked it. The restart is at seven thirty, not seven.".length,
    ]);
    expect(result.plannedSpeech).toBe(
      "I checked it. The restart is at seven thirty, not seven. Optional detail.",
    );
    expect(result.malformed).toBe(false);
  });

  test("coalesces short sentences into one TTS phrase", async () => {
    const speech: string[] = [];
    const parser = new VoiceResponseParser({
      onSpeech: (text) => { speech.push(text); },
      onMessage: () => {},
      onIgnore: () => {},
    });

    await parser.push("Персики купила. ");
    expect(speech).toEqual([]);
    await parser.push("Уже слишком мягкие.");

    expect(speech).toEqual([]);
    expect((await parser.finish()).plannedSpeech).toBe("Персики купила. Уже слишком мягкие.");
    expect(speech).toEqual(["Персики купила. Уже слишком мягкие."]);
  });

  test("commits a short trailing phrase after a bounded stream idle", async () => {
    const speech: string[] = [];
    const parser = new VoiceResponseParser({
      onSpeech: (text) => { speech.push(text); },
      onMessage: () => {},
      onIgnore: () => {},
    });

    await parser.push("Короткий ответ.");
    await Bun.sleep(250);

    expect(speech).toEqual(["Короткий ответ."]);
    expect((await parser.finish()).plannedSpeech).toBe("Короткий ответ.");
  });

  test("continues streaming longer speech before the turn finishes", async () => {
    const speech: string[] = [];
    const parser = new VoiceResponseParser({
      onSpeech: (text) => { speech.push(text); },
      onMessage: () => {},
      onIgnore: () => {},
    });

    const longerPhrase = "Первую короткую мысль лучше связать со второй, чтобы голос получил достаточно контекста. ";
    await parser.push(longerPhrase);

    expect(speech).toEqual([longerPhrase.trim()]);
    expect((await parser.finish()).plannedSpeech).toBe(longerPhrase.trim());
  });
});
