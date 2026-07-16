import { diceRollHistoryEventFromCard } from "../dice-roll-contract";

export interface StickerLike {
  name: string;
}

export interface SerializableMessageComponent {
  toJSON(): unknown;
}

function collectTextDisplayContent(value: unknown, output: string[]): void {
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.content === "string" && record.content.trim() !== "") {
    output.push(record.content);
  }
  if (!Array.isArray(record.components)) return;
  for (const component of record.components) collectTextDisplayContent(component, output);
}

/** Include Discord Components V2 text displays in the message text visible to history and other bots. */
export function messageDisplayContent(
  content: string,
  components: Iterable<SerializableMessageComponent>,
  sourceUsername = "unknown",
): string {
  const parts = content.trim() === "" ? [] : [content];
  for (const component of components) {
    const value = component.toJSON();
    if (content.trim() === "" && value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const cardText: string[] = [];
      collectTextDisplayContent(value, cardText);
      const historyEvent = typeof record.id === "number"
        ? diceRollHistoryEventFromCard(cardText.join("\n"), record.id, sourceUsername)
        : null;
      if (historyEvent !== null) return historyEvent;
    }
    collectTextDisplayContent(value, parts);
  }
  return parts.join("\n");
}

/** Build the prompt-visible sticker tags appended to message history content. */
export function stickerTags(stickers: Iterable<StickerLike>): string {
  return [...stickers]
    .map((sticker) => sticker.name.replace(/[\t\n\r<>]+/g, " ").trim())
    .filter((name) => name !== "")
    .map((name) => `<sticker>${name}</sticker>`)
    .join(" ");
}

/** Append sticker tags without dropping the original message text or URL content. */
export function appendStickerTags(content: string, stickers: Iterable<StickerLike>): string {
  const tags = stickerTags(stickers);
  if (tags === "") return content;
  return content.trim() === "" ? tags : `${content} ${tags}`;
}
