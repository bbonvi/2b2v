const XML_LIKE_TAG_RE = /<\/?[A-Za-z_][A-Za-z0-9_.:-]*(?=\s|\/?>|$)(?:[^<>]*>?|$)/;

export class OutboundXmlTagError extends Error {
  constructor() {
    super(
      "A Discord text message was not sent because it contained XML-like markup outside a complete Markdown code span and was likely malformed. Correct only that message, do not repeat messages already sent, and do not expose private tool data or reasoning.",
    );
    this.name = "OutboundXmlTagError";
  }
}

function textOutsideCompleteBacktickSpans(text: string): string {
  const visible = text.split("");
  let cursor = 0;

  while (cursor < text.length) {
    if (text[cursor] !== "`") {
      cursor += 1;
      continue;
    }

    let openerEnd = cursor + 1;
    while (text[openerEnd] === "`") openerEnd += 1;
    const delimiterLength = openerEnd - cursor;
    let candidate = openerEnd;
    let closeEnd: number | undefined;

    while (candidate < text.length) {
      const next = text.indexOf("`", candidate);
      if (next === -1) break;
      let runEnd = next + 1;
      while (text[runEnd] === "`") runEnd += 1;
      if (runEnd - next === delimiterLength) {
        closeEnd = runEnd;
        break;
      }
      candidate = runEnd;
    }

    if (closeEnd === undefined) {
      cursor = openerEnd;
      continue;
    }
    for (let index = cursor; index < closeEnd; index += 1) {
      visible[index] = " ";
    }
    cursor = closeEnd;
  }

  return visible.join("");
}

/** Reject Discord text that contains XML-like markup outside complete Markdown code spans. */
export function assertSafeDiscordText(text: string): void {
  if (XML_LIKE_TAG_RE.test(textOutsideCompleteBacktickSpans(text))) {
    throw new OutboundXmlTagError();
  }
}
