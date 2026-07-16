export const DICE_ROLL_CARD_COMPONENT_IDS = {
  en: 0x2b2d20,
  ru: 0x2b2d21,
} as const;

/** Escape one canonical dice history attribute without translating its value. */
export function escapeDiceRollXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\t", "&#9;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** Identify the stable prompt-only representation of a public dice card. */
export function isDiceRollHistoryEvent(value: string): boolean {
  return /^<dice_roll(?:\s[^<>]*)?\/>$/.test(value.trim());
}

function unescapeDiscordDisplayText(value: string): string {
  return value.replace(/\\([*_`~|>\\])/g, "$1").replaceAll("\u200B", "");
}

/** Recover a canonical event from another bot's recognized public dice card. */
export function diceRollHistoryEventFromCard(content: string, componentId: number, sourceUsername: string): string | null {
  const lang = componentId === DICE_ROLL_CARD_COMPONENT_IDS.ru
    ? "ru"
    : componentId === DICE_ROLL_CARD_COMPONENT_IDS.en
      ? "en"
      : null;
  if (lang === null) return null;

  const lines = content.split("\n").filter((line) => line !== "");
  const resultMatch = lines[0]?.match(/^# (?:(✅|❌) (?:SUCCESS|FAILURE|УСПЕХ|ПРОВАЛ) )?`🎲 (-?\d+)`$/);
  if (resultMatch === null || resultMatch === undefined) return null;

  const heading = lines.length > 2 ? lines[1] : undefined;
  const metadata = lines.at(-1);
  if (metadata === undefined) return null;
  const targetHeading = heading?.match(/^## (.*) — (?:Difficulty|Сложность) `(-?\d+)`$/);
  const label = targetHeading?.[1] ?? heading?.match(/^## (.*)$/)?.[1];
  const target = targetHeading?.[2];
  const pills = [...metadata.matchAll(/`([^`]*)`/g)].flatMap((match) => match[1] === undefined ? [] : [match[1]]);
  const notationIndex = pills.findIndex((value, index) => index > 0 && /^(?:\d+)?d\d+(?:[+-]\d+)?$/.test(value));
  const actorName = pills[0];
  const notation = pills[notationIndex];
  const total = resultMatch[2];
  const icon = resultMatch[1];
  if (actorName === undefined || notation === undefined || total === undefined || notationIndex < 1) return null;

  const trait = notationIndex > 1 ? pills[1] : undefined;
  const detail = pills[notationIndex + 1];
  const modeMatch = detail?.match(/^(🟢|🔴) (?:Advantage|Disadvantage|Преимущество|Помеха) \((.*)\)$/);
  const diceMatch = detail?.match(/^(?:Dice|Кубики) \((.*)\)$/);
  const rollsText = modeMatch?.[2] ?? diceMatch?.[1];
  const rolls = rollsText === undefined
    ? []
    : [...rollsText.matchAll(/🎲 (-?\d+)/g)].flatMap((match) => match[1] === undefined ? [] : [match[1]]);
  const mode = modeMatch?.[1] === "🟢" ? "advantage" : modeMatch?.[1] === "🔴" ? "disadvantage" : "normal";
  if (mode !== "normal" && rolls.length === 0) return null;
  const kept = mode === "advantage"
    ? Math.max(...rolls.map(Number))
    : mode === "disadvantage"
      ? Math.min(...rolls.map(Number))
      : null;

  const attributes: Array<[string, string]> = [
    ["source", sourceUsername],
    ["actor_name", unescapeDiscordDisplayText(actorName)],
    ["lang", lang],
    ["visibility", "public"],
    ["notation", notation],
    ["mode", mode],
    ...(rolls.length === 0 ? [] : [["rolls", rolls.join(",")] as [string, string]]),
    ...(kept === null ? [] : [["kept", String(kept)] as [string, string]]),
    ["total", total],
    ...(label === undefined ? [] : [["label", unescapeDiscordDisplayText(label)] as [string, string]]),
    ...(trait === undefined ? [] : [["trait", unescapeDiscordDisplayText(trait)] as [string, string]]),
    ...(target === undefined || icon === undefined ? [] : [
      ["target", target] as [string, string],
      ["outcome", icon === "✅" ? "success" : "failure"] as [string, string],
    ]),
  ];
  return `<dice_roll ${attributes.map(([key, value]) => `${key}="${escapeDiceRollXmlAttribute(value)}"`).join(" ")}/>`;
}
