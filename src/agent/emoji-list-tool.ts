import { Type, type Static } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { EmojiEntry } from "../discord/emoji-cache.ts";
import { markReadOnlyTool } from "./tool-effects.ts";

export interface GuildEmojiInventory {
  guildId: string;
  guildName: string;
  emojis: EmojiEntry[];
}

export interface EmojiListToolDeps {
  guildId: string;
  getCachedEmojis: (guildId: string) => EmojiEntry[] | undefined;
  shouldRefresh: (guildId: string) => boolean;
  refreshEmojis: (guildId: string) => Promise<EmojiEntry[]>;
  getAllGuildEmojis: () => GuildEmojiInventory[];
  resolveEmoji: (name: string) => Pick<EmojiEntry, "id" | "animated"> | undefined;
}

const ListEmojisParams = Type.Object({
  scope: Type.Optional(Type.Union([
    Type.Literal("current"),
    Type.Literal("all"),
  ], {
    default: "current",
    description: "Use all to include emojis from every Discord server available to the bot.",
  })),
});

type ListEmojisInput = Static<typeof ListEmojisParams>;

function compareEmojis(a: EmojiEntry, b: EmojiEntry): number {
  const nameComparison = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  return nameComparison !== 0 ? nameComparison : a.id.localeCompare(b.id);
}

/**
 * Format custom emoji inventory for compact model discovery.
 * Rows include only reply syntax and the ID needed to construct a visual-reference URL.
 */
export function buildEmojiListOutput(emojis: EmojiEntry[]): string {
  if (emojis.length === 0) {
    return "No custom emojis available for this server.";
  }

  const rows = emojis.map((emoji) => {
    const kind = emoji.animated ? "A" : "S";
    return `${kind} | :${emoji.name}: | ${emoji.id}`;
  });

  return [
    `Available custom emojis (${emojis.length})`,
    "Rows: kind | emoji | id (S=static, A=animated)",
    "Image URL: https://cdn.discordapp.com/emojis/{id}.png?size=4096",
    ...rows,
  ].join("\n");
}

/** Format the on-demand cross-guild inventory and show duplicate-name resolution. */
export function buildAllGuildEmojiListOutput(
  inventories: GuildEmojiInventory[],
  currentGuildId: string,
  resolveEmoji: EmojiListToolDeps["resolveEmoji"],
): string {
  const guilds = inventories
    .filter((inventory) => inventory.emojis.length > 0)
    .sort((a, b) => {
      if (a.guildId === currentGuildId) return -1;
      if (b.guildId === currentGuildId) return 1;
      const nameComparison = a.guildName.localeCompare(b.guildName);
      return nameComparison !== 0 ? nameComparison : a.guildId.localeCompare(b.guildId);
    });
  const count = guilds.reduce((total, inventory) => total + inventory.emojis.length, 0);
  if (count === 0) return "No custom emojis available across connected servers.";

  const nameCounts = new Map<string, number>();
  for (const { emojis } of guilds) {
    for (const emoji of emojis) nameCounts.set(emoji.name, (nameCounts.get(emoji.name) ?? 0) + 1);
  }
  const selectedIds = new Map(
    [...nameCounts]
      .filter(([, nameCount]) => nameCount > 1)
      .map(([name]) => [name, resolveEmoji(name)?.id]),
  );

  const sections = guilds.flatMap((inventory) => {
    const current = inventory.guildId === currentGuildId ? " | current" : "";
    const rows = [...inventory.emojis].sort(compareEmojis).map((emoji) => {
      if (!selectedIds.has(emoji.name)) return `${emoji.animated ? "A" : "S"} | :${emoji.name}: | ${emoji.id}`;
      const selected = selectedIds.get(emoji.name) === emoji.id ? ", selected" : "";
      return `${emoji.animated ? "A" : "S"} | :${emoji.name}: | ${emoji.id} | duplicate${selected}`;
    });
    return [
      `Server: ${inventory.guildName} | ${inventory.guildId}${current} | ${inventory.emojis.length} emojis`,
      ...rows,
    ];
  });

  return [
    `Available custom emojis across ${guilds.length} servers (${count})`,
    "Rows: kind | emoji | id | duplicate status (S=static, A=animated)",
    "Image URL: https://cdn.discordapp.com/emojis/{id}.png?size=4096",
    ...sections,
  ].join("\n");
}

export function createEmojiListTool(deps: EmojiListToolDeps): AgentTool {
  const { guildId, getCachedEmojis, shouldRefresh, refreshEmojis, getAllGuildEmojis, resolveEmoji } = deps;

  return markReadOnlyTool({
    name: "list_emojis",
    label: "list_emojis",
    description: "",
    parameters: ListEmojisParams,

    async execute(_toolCallId: string, params: unknown): Promise<AgentToolResult<{ count: number; guildCount?: number } | { error: boolean }>> {
      const scope = (params as ListEmojisInput).scope ?? "current";
      if (scope === "all") {
        const inventories = getAllGuildEmojis().filter((inventory) => inventory.emojis.length > 0);
        return {
          content: [{ type: "text", text: buildAllGuildEmojiListOutput(inventories, guildId, resolveEmoji) }],
          details: {
            count: inventories.reduce((total, inventory) => total + inventory.emojis.length, 0),
            guildCount: inventories.length,
          },
        };
      }

      let emojis = getCachedEmojis(guildId);

      if (emojis === undefined || shouldRefresh(guildId)) {
        try {
          emojis = await refreshEmojis(guildId);
        } catch {
          if (emojis === undefined) {
            return {
              content: [{ type: "text", text: "Unable to fetch custom emojis; the bot may lack permission to view server emojis." }],
              details: { error: true },
            };
          }
        }
      }

      const sorted = [...emojis].sort(compareEmojis);

      return {
        content: [{ type: "text", text: buildEmojiListOutput(sorted) }],
        details: { count: sorted.length },
      };
    },
  });
}
