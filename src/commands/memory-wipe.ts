import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { isAdmin, type PermissionContext } from "./permissions.ts";

export interface WipeResult {
  memoriesDeleted: number;
  messagesDeleted: number;
}

export interface WipeRecentResult {
  messagesDeleted: number;
}

export interface MemoryWipeDeps {
  /** Wipe guild memories and message history. Portable user memories are not guild-owned. */
  wipeGuild: (guildId: string) => Promise<WipeResult>;
  /** Wipe N most recent messages from a specific channel. */
  wipeRecent: (guildId: string, channelId: string, count: number) => Promise<WipeRecentResult>;
  adminUserIds: string[];
}

export const memoryWipeCommandDefinition = new SlashCommandBuilder()
  .setName("memory-wipe")
  .setDescription("Clear all bot memory and message history for this guild (admin only)")
  .addIntegerOption((opt) =>
    opt
      .setName("recent")
      .setDescription("Delete only the last N messages from current channel (omit for full guild wipe)")
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(1000)
  )
  .addStringOption((opt) =>
    opt
      .setName("confirm")
      .setDescription('Type "WIPE" to confirm (required for full guild wipe)')
      .setRequired(false)
  );

export function createMemoryWipeHandler(deps: MemoryWipeDeps) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    const permCtx: PermissionContext = {
      memberPermissions: interaction.memberPermissions?.bitfield ?? null,
      userId: interaction.user.id,
      adminUserIds: deps.adminUserIds,
    };

    if (!isAdmin(permCtx)) {
      await interaction.reply({ content: "Admin access required.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.guildId === null) {
      await interaction.reply({ content: "This command can only be used in a guild.", flags: MessageFlags.Ephemeral });
      return;
    }

    // Check for recent mode (channel-scoped, no confirmation required)
    const recent = interaction.options.getInteger("recent");
    if (recent !== null) {
      try {
        const result = await deps.wipeRecent(interaction.guildId, interaction.channelId, recent);
        await interaction.reply({
          content: `Deleted ${String(result.messagesDeleted)} messages from this channel.`,
          flags: MessageFlags.Ephemeral,
        });
      } catch (_err) {
        await interaction.reply({
          content: "Recent wipe failed. Check logs for details.",
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    // Full guild wipe requires confirmation
    const confirm = interaction.options.getString("confirm");
    if (confirm !== "WIPE") {
      await interaction.reply({
        content: 'Confirmation required. Pass `confirm: WIPE` to proceed.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      const result = await deps.wipeGuild(interaction.guildId);
      await interaction.reply({
        content: `Guild data wiped: ${String(result.memoriesDeleted)} memories, ${String(result.messagesDeleted)} messages deleted.`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (_err) {
      await interaction.reply({
        content: "Memory wipe failed. Check logs for details.",
        flags: MessageFlags.Ephemeral,
      });
    }
  };
}
