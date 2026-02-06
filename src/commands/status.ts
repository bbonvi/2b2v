import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { isAdmin, type PermissionContext } from "./permissions.ts";

export interface StatusStats {
  /** Process uptime in milliseconds. */
  uptimeMs: number;
  /** Number of guilds the bot is in. */
  guildCount: number;
  /** Total messages stored in DB (optional). */
  messageCount?: number;
  /** Total memories stored in DB (optional). */
  memoryCount?: number;
  /** Total active schedules (optional). */
  scheduleCount?: number;
}

export interface StatusCommandDeps {
  getStats: () => StatusStats | Promise<StatusStats>;
  adminUserIds: string[];
}

export const statusCommandDefinition = new SlashCommandBuilder()
  .setName("status")
  .setDescription("Show bot health, uptime, and basic stats (admin only)");

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${String(days)}d`);
  if (hours > 0) parts.push(`${String(hours)}h`);
  if (minutes > 0) parts.push(`${String(minutes)}m`);
  parts.push(`${String(secs)}s`);
  return parts.join(" ");
}

function buildStatusEmbed(stats: StatusStats): {
  title: string;
  fields: Array<{ name: string; value: string; inline: boolean }>;
  color: number;
} {
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    { name: "Uptime", value: formatUptime(stats.uptimeMs), inline: true },
    { name: "Guilds", value: String(stats.guildCount), inline: true },
  ];

  if (stats.messageCount !== undefined) {
    fields.push({ name: "Messages", value: String(stats.messageCount), inline: true });
  }
  if (stats.memoryCount !== undefined) {
    fields.push({ name: "Memories", value: String(stats.memoryCount), inline: true });
  }
  if (stats.scheduleCount !== undefined) {
    fields.push({ name: "Schedules", value: String(stats.scheduleCount), inline: true });
  }

  return {
    title: "Bot Status",
    fields,
    color: 0x57f287, // green
  };
}

export function createStatusHandler(deps: StatusCommandDeps) {
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

    const stats = await deps.getStats();
    const embed = buildStatusEmbed(stats);
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  };
}

// Export internals for testing
export { formatUptime, buildStatusEmbed };
