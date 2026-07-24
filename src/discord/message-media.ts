import { diceRollHistoryEventFromCard } from "../dice-roll-contract";

export interface StickerLike {
  name: string;
}

export interface SerializableMessageComponent {
  toJSON(): unknown;
}

export interface DisplayEmbed {
  author?: { name?: string | null } | null;
  title?: string | null;
  url?: string | null;
  description?: string | null;
  fields?: Iterable<{ name?: string | null; value?: string | null }>;
  footer?: { text?: string | null } | null;
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

function appendEmbedText(embed: DisplayEmbed, output: string[]): void {
  const parts: string[] = [];
  const author = embed.author?.name?.trim();
  const title = embed.title?.trim();
  const url = embed.url?.trim();
  const description = embed.description?.trim();
  const fields = [...(embed.fields ?? [])];
  const footer = embed.footer?.text?.trim();
  const hasText = [author, title, description, footer].some((value) => value !== undefined && value !== "")
    || fields.some((field) => {
      const name = field.name?.trim();
      const value = field.value?.trim();
      return (name !== undefined && name !== "") || (value !== undefined && value !== "");
    });
  if (!hasText) return;

  if (author !== undefined && author !== "") parts.push(author);
  if (title !== undefined && title !== "") parts.push(title);
  if (url !== undefined && url !== "") parts.push(url);
  if (description !== undefined && description !== "") parts.push(description);

  for (const field of fields) {
    const name = field.name?.trim();
    const value = field.value?.trim();
    if (name !== undefined && name !== "" && value !== undefined && value !== "") {
      parts.push(`${name}: ${value}`);
    } else if (name !== undefined && name !== "") {
      parts.push(name);
    } else if (value !== undefined && value !== "") {
      parts.push(value);
    }
  }

  if (footer !== undefined && footer !== "") parts.push(footer);
  output.push(...parts);
}

/** Include raw Discord Components V2 text displays in stored message content. */
export function messageDisplayContentFromData(
  content: string,
  components: Iterable<unknown>,
  sourceUsername = "unknown",
  embeds: Iterable<DisplayEmbed> = [],
): string {
  const parts = content.trim() === "" ? [] : [content];
  for (const component of components) {
    const value = component;
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
  for (const embed of embeds) appendEmbedText(embed, parts);
  return parts.join("\n");
}

/** Include Discord component and embed text in the message text visible to history and other bots. */
export function messageDisplayContent(
  content: string,
  components: Iterable<SerializableMessageComponent>,
  sourceUsername = "unknown",
  embeds: Iterable<DisplayEmbed> = [],
): string {
  return messageDisplayContentFromData(
    content,
    [...components].map((component) => component.toJSON()),
    sourceUsername,
    embeds,
  );
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
