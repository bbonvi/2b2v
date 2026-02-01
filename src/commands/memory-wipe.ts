import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { isAdmin, type PermissionContext } from "./permissions.ts";

export interface WipeResult {
  memoriesDeleted: number;
  messagesDeleted: number;
}

export interface MemoryWipeDeps {
  /** Wipe all guild-scoped memories and messages. Returns counts. */
  wipeGuild: (guildId: string) => Promise<WipeResult>;
  adminUserIds: string[];
}

export const memoryWipeCommandDefinition = new SlashCommandBuilder()
  .setName("memory-wipe")
  .setDescription("Clear all bot memory and message history for this guild (admin only)")
  .addStringOption((opt) =>
    opt
      .setName("confirm")
      .setDescription('Type "WIPE" to confirm')
      .setRequired(true)
  );

export function createMemoryWipeHandler(deps: MemoryWipeDeps) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    const permCtx: PermissionContext = {
      memberPermissions: interaction.memberPermissions?.bitfield ?? null,
      userId: interaction.user.id,
      adminUserIds: deps.adminUserIds,
    };

    if (!isAdmin(permCtx)) {
      await interaction.reply({ content: "Admin access required.", ephemeral: true });
      return;
    }

    if (interaction.guildId === null) {
      await interaction.reply({ content: "This command can only be used in a guild.", ephemeral: true });
      return;
    }

    const confirm = interaction.options.getString("confirm");
    if (confirm !== "WIPE") {
      await interaction.reply({
        content: 'Confirmation required. Pass `confirm: WIPE` to proceed.',
        ephemeral: true,
      });
      return;
    }

    try {
      const result = await deps.wipeGuild(interaction.guildId);
      await interaction.reply({
        content: `Guild data wiped: ${String(result.memoriesDeleted)} memories, ${String(result.messagesDeleted)} messages deleted.`,
        ephemeral: true,
      });
    } catch (_err) {
      await interaction.reply({
        content: "Memory wipe failed. Check logs for details.",
        ephemeral: true,
      });
    }
  };
}
