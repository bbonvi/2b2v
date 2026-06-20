import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { EmojiEntry } from "../discord/emoji-cache.ts";

export interface EmojiListToolDeps {
  guildId: string;
  getCachedEmojis: (guildId: string) => EmojiEntry[] | undefined;
  shouldRefresh: (guildId: string) => boolean;
  refreshEmojis: (guildId: string) => Promise<EmojiEntry[]>;
}

const ListEmojisParams = Type.Object({});

/**
 * Format custom emoji inventory for compact model discovery.
 * Rows intentionally include both the `:name:` form 2B should write and the raw Discord form for disambiguation.
 */
export function buildEmojiListOutput(emojis: EmojiEntry[]): string {
  if (emojis.length === 0) {
    return "No custom emojis available for this server.";
  }

  const rows = emojis.map((emoji) => {
    const kind = emoji.animated ? "A" : "S";
    const discord = emoji.animated
      ? `<a:${emoji.name}:${emoji.id}>`
      : `<:${emoji.name}:${emoji.id}>`;
    return `${kind} | ${emoji.name} | :${emoji.name}: | ${discord}`;
  });

  return [
    `Available custom emojis (${emojis.length})`,
    "Legend: S=static, A=animated; use :name: in replies. Outbound translation sends the Discord form.",
    "Rows: kind | name | use | discord",
    ...rows,
  ].join("\n");
}

export function createEmojiListTool(deps: EmojiListToolDeps): AgentTool {
  const { guildId, getCachedEmojis, shouldRefresh, refreshEmojis } = deps;

  return {
    name: "list_emojis",
    label: "list_emojis",
    description:
      "Discover this server's custom emojis. Use this only for discovery; 2B can use matching emojis sparingly through the :name: syntax, but she should not spam emojis.",
    parameters: ListEmojisParams,

    async execute(_toolCallId: string): Promise<AgentToolResult<{ count: number } | { error: boolean }>> {
      let emojis = getCachedEmojis(guildId);

      if (emojis === undefined || shouldRefresh(guildId)) {
        try {
          emojis = await refreshEmojis(guildId);
        } catch {
          if (emojis === undefined) {
            return {
              content: [{ type: "text", text: "Unable to fetch custom emojis. The bot may lack permission to view server emojis." }],
              details: { error: true },
            };
          }
        }
      }

      const sorted = [...emojis].sort((a, b) => {
        const nc = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        return nc !== 0 ? nc : a.id.localeCompare(b.id);
      });

      return {
        content: [{ type: "text", text: buildEmojiListOutput(sorted) }],
        details: { count: sorted.length },
      };
    },
  };
}
