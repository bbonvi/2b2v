import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { isAdmin, type PermissionContext } from "./permissions.ts";
import type {
  ScheduleRow,
  CreateScheduleInput,
  ListSchedulesFilter,
} from "../db/schedule-repository.ts";

export interface ScheduleCommandDeps {
  listSchedules: (filter: ListSchedulesFilter) => ScheduleRow[];
  createSchedule: (input: CreateScheduleInput) => string;
  deleteSchedule: (id: string) => boolean;
  /** Notify engine that a schedule was created so it can register the job. */
  onScheduleCreated: (scheduleId: string) => void;
  /** Notify engine that a schedule was removed so it can unregister the job. */
  onScheduleRemoved: (scheduleId: string) => void;
  adminUserIds: string[];
}

export const scheduleCommandDefinition = new SlashCommandBuilder()
  .setName("schedule")
  .setDescription("Manage scheduled messages (admin only)")
  .addSubcommand((sub) =>
    sub.setName("list").setDescription("List all schedules for this guild")
  )
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add a new schedule")
      .addStringOption((opt) =>
        opt
          .setName("type")
          .setDescription("Schedule type: cron or one_off")
          .setRequired(true)
          .addChoices(
            { name: "cron", value: "cron" },
            { name: "one_off", value: "one_off" }
          )
      )
      .addStringOption((opt) =>
        opt
          .setName("channel")
          .setDescription("Target channel ID")
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("message")
          .setDescription("Message content to send")
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("cron")
          .setDescription("Cron expression (required for cron type)")
          .setRequired(false)
      )
      .addStringOption((opt) =>
        opt
          .setName("run-at")
          .setDescription("ISO 8601 datetime (required for one_off type)")
          .setRequired(false)
      )
      .addStringOption((opt) =>
        opt
          .setName("timezone")
          .setDescription("Timezone (defaults to guild timezone)")
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription("Remove a schedule by ID")
      .addStringOption((opt) =>
        opt
          .setName("id")
          .setDescription("Schedule ID to remove")
          .setRequired(true)
      )
  );

const MESSAGE_PREVIEW_LIMIT = 80;
const DISCORD_MESSAGE_LIMIT = 2000;

function truncateMessage(text: string, limit: number = MESSAGE_PREVIEW_LIMIT): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - 1) + "…";
}

export function formatScheduleRow(row: ScheduleRow): string {
  const status = row.enabled ? "" : " ⏸";
  const isPast = row.type === "one_off" && (row.runAt ?? 0) < Date.now();
  const timing =
    row.type === "cron"
      ? `\`${row.cronExpression ?? "?"}\``
      : `<t:${Math.floor((row.runAt ?? 0) / 1000)}:R>${isPast ? " **[past]**" : ""}`;
  const msg = truncateMessage(row.messageContent.replaceAll("\n", " "));

  return `\`${row.id}\`${status} ${row.type} ${timing} — ${msg}`;
}

/**
 * Format a list of schedules into Discord-safe chunks (<=2000 chars each).
 * Sorts enabled before disabled, then newest first.
 */
export function formatScheduleList(schedules: ScheduleRow[]): string[] {
  if (schedules.length === 0) return [];

  const sorted = [...schedules].sort((a, b) => {
    // enabled first
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    // newest first
    return b.createdAt - a.createdAt;
  });

  const lines = sorted.map(formatScheduleRow);
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const separator = current.length > 0 ? "\n" : "";
    if (current.length + separator.length + line.length > DISCORD_MESSAGE_LIMIT) {
      if (current.length > 0) chunks.push(current);
      current = line;
    } else {
      current += separator + line;
    }
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

export function createScheduleHandler(deps: ScheduleCommandDeps) {
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    const permCtx: PermissionContext = {
      memberPermissions: interaction.memberPermissions?.bitfield ?? null,
      userId: interaction.user.id,
      adminUserIds: deps.adminUserIds,
    };

    if (!isAdmin(permCtx)) {
      await interaction.reply({
        content: "Admin access required.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.guildId === null) {
      await interaction.reply({
        content: "This command can only be used in a guild.",
        ephemeral: true,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "list") {
      const schedules = deps.listSchedules({ guildId: interaction.guildId });

      if (schedules.length === 0) {
        await interaction.reply({
          content: "No schedules found for this guild.",
          ephemeral: true,
        });
        return;
      }

      const chunks = formatScheduleList(schedules);
      await interaction.reply({ content: chunks[0], ephemeral: true });
      for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp({ content: chunks[i], ephemeral: true });
      }
      return;
    }

    if (subcommand === "add") {
      const type = interaction.options.getString("type");
      const channelId = interaction.options.getString("channel");
      const message = interaction.options.getString("message");
      const cronExpr = interaction.options.getString("cron");
      const runAtStr = interaction.options.getString("run-at");
      const timezone = interaction.options.getString("timezone");

      if (message === null || message === "") {
        await interaction.reply({
          content: "A message is required.",
          ephemeral: true,
        });
        return;
      }

      if (type === "cron") {
        if (cronExpr === null || cronExpr === "") {
          await interaction.reply({
            content:
              "A cron expression is required for cron schedules. Use the `cron` option.",
            ephemeral: true,
          });
          return;
        }

        const id = deps.createSchedule({
          guildId: interaction.guildId,
          channelId: channelId ?? interaction.channelId,
          source: "admin",
          type: "cron",
          cronExpression: cronExpr,
          timezone: timezone ?? "UTC",
          messageContent: message,
        });

        deps.onScheduleCreated(id);
        await interaction.reply({
          content: `Schedule created: **${id}**\nCron: \`${cronExpr}\``,
          ephemeral: true,
        });
        return;
      }

      if (type === "one_off") {
        if (runAtStr === null || runAtStr === "") {
          await interaction.reply({
            content:
              "A run-at datetime is required for one_off schedules. Use the `run-at` option (ISO 8601).",
            ephemeral: true,
          });
          return;
        }

        const runAtMs = new Date(runAtStr).getTime();
        if (Number.isNaN(runAtMs)) {
          await interaction.reply({
            content: "Invalid datetime. Use ISO 8601 format (e.g. 2025-06-15T10:00:00Z).",
            ephemeral: true,
          });
          return;
        }

        const id = deps.createSchedule({
          guildId: interaction.guildId,
          channelId: channelId ?? interaction.channelId,
          source: "admin",
          type: "one_off",
          runAt: runAtMs,
          timezone: timezone ?? "UTC",
          messageContent: message,
        });

        deps.onScheduleCreated(id);
        await interaction.reply({
          content: `Schedule created: **${id}**\nRuns at: ${new Date(runAtMs).toISOString()}`,
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({
        content: "Invalid type. Use `cron` or `one_off`.",
        ephemeral: true,
      });
      return;
    }

    if (subcommand === "remove") {
      const id = interaction.options.getString("id");
      if (id === null || id === "") {
        await interaction.reply({
          content: "A schedule id is required.",
          ephemeral: true,
        });
        return;
      }

      const deleted = deps.deleteSchedule(id);
      if (!deleted) {
        await interaction.reply({
          content: `Schedule not found: \`${id}\``,
          ephemeral: true,
        });
        return;
      }

      deps.onScheduleRemoved(id);
      await interaction.reply({
        content: `Schedule **${id}** removed.`,
        ephemeral: true,
      });
    }
  };
}
