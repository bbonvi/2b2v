import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { isAdmin, type PermissionContext } from "./permissions.ts";
import type { GuildConfig } from "../config/types.ts";

// adminUserIds intentionally excluded — prevents privilege escalation via /config set
export const CONFIGURABLE_KEYS = [
  "model",
  "thinkingLevel",
  "timezone",
  "triggers.mention",
  "triggers.keywords",
  "triggers.randomChance",
  "trim.trimTrigger",
  "trim.trimTarget",
  "memoryRetentionDays",
  "imageMaxDimension",
  "messageDelay.base",
  "messageDelay.perChar",
] as const;

export type ConfigKey = (typeof CONFIGURABLE_KEYS)[number];

export interface ConfigCommandDeps {
  getGuildConfig: (guildId: string) => GuildConfig;
  /** Apply a full updated guild config and persist it. */
  updateGuildConfig: (guildId: string, config: GuildConfig) => void;
  adminUserIds: string[];
}

export const configCommandDefinition = new SlashCommandBuilder()
  .setName("config")
  .setDescription("View or modify guild settings (admin only)")
  .addSubcommand((sub) =>
    sub
      .setName("list")
      .setDescription("Show all current settings")
  )
  .addSubcommand((sub) =>
    sub
      .setName("get")
      .setDescription("Show a specific setting")
      .addStringOption((opt) =>
        opt.setName("key").setDescription("Setting key").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Update a setting")
      .addStringOption((opt) =>
        opt.setName("key").setDescription("Setting key").setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("value").setDescription("New value").setRequired(true)
      )
  );

/**
 * Validate a config value for a given key.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateConfigValue(key: string, value: string): string | null {
  if (!CONFIGURABLE_KEYS.includes(key as ConfigKey)) {
    return `Unknown key: \`${key}\`. Valid keys: ${CONFIGURABLE_KEYS.join(", ")}`;
  }

  switch (key) {
    case "model":
    case "thinkingLevel":
      // Any non-empty string is acceptable
      if (value === "") return "Value must not be empty.";
      return null;

    case "timezone":
      if (value === "") return "Timezone must not be empty.";
      return null;

    case "triggers.mention": {
      if (value !== "true" && value !== "false") {
        return "Value must be `true` or `false`.";
      }
      return null;
    }

    case "triggers.keywords":
      // Comma-separated list, empty is allowed (clears keywords)
      return null;

    case "triggers.randomChance": {
      const n = Number(value);
      if (Number.isNaN(n) || n < 0 || n > 1) {
        return "Value must be a number between 0 and 1.";
      }
      return null;
    }

    case "trim.trimTrigger":
    case "trim.trimTarget": {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return "Value must be a positive integer.";
      }
      return null;
    }

    case "memoryRetentionDays": {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return "Value must be a positive integer.";
      }
      return null;
    }

    case "imageMaxDimension": {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return "Value must be a positive integer.";
      }
      return null;
    }

    case "messageDelay.base":
    case "messageDelay.perChar": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        return "Value must be a non-negative integer.";
      }
      return null;
    }

    default:
      return `Unknown key: \`${key}\`.`;
  }
}

/** Read a nested config value by dot-separated key. */
export function formatConfigValue(config: GuildConfig, key: string): string {
  const parts = key.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (current === undefined || current === null) return "(not set)";
    current = (current as Record<string, unknown>)[part];
  }
  if (current === undefined || current === null) return "(not set)";
  if (Array.isArray(current)) {
    const joined = current.join(", ");
    return joined !== "" ? joined : "(empty)";
  }
  return typeof current === "object" ? JSON.stringify(current) : String(current as string | number | boolean);
}

/** Apply a validated string value to a GuildConfig, returning the mutated config. */
function applyConfigValue(config: GuildConfig, key: string, value: string): GuildConfig {
  const updated = { ...config };

  switch (key) {
    case "model":
      updated.model = value;
      break;
    case "thinkingLevel":
      updated.thinkingLevel = value;
      break;
    case "timezone":
      updated.timezone = value;
      break;
    case "triggers.mention":
      updated.triggers = { ...updated.triggers, mention: value === "true" };
      break;
    case "triggers.keywords":
      updated.triggers = {
        ...updated.triggers,
        keywords: value === "" ? [] : value.split(",").map((s) => s.trim()),
      };
      break;
    case "triggers.randomChance":
      updated.triggers = { ...updated.triggers, randomChance: Number(value) };
      break;
    case "trim.trimTrigger":
      updated.trim = { ...updated.trim, trimTrigger: Number(value) };
      break;
    case "trim.trimTarget":
      updated.trim = { ...updated.trim, trimTarget: Number(value) };
      break;
    case "memoryRetentionDays":
      updated.memoryRetentionDays = Number(value);
      break;
    case "imageMaxDimension":
      updated.imageMaxDimension = Number(value);
      break;
    case "messageDelay.base":
      updated.messageDelay = { ...updated.messageDelay, base: Number(value) };
      break;
    case "messageDelay.perChar":
      updated.messageDelay = { ...updated.messageDelay, perChar: Number(value) };
      break;
  }

  return updated;
}

export function createConfigHandler(deps: ConfigCommandDeps) {
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

    const subcommand = interaction.options.getSubcommand();
    const config = deps.getGuildConfig(interaction.guildId);

    if (subcommand === "list") {
      const fields = CONFIGURABLE_KEYS.map((key) => ({
        name: key,
        value: formatConfigValue(config, key),
        inline: true,
      }));
      await interaction.reply({
        embeds: [{ title: "Guild Configuration", fields, color: 0x5865f2 }],
        ephemeral: true,
      });
      return;
    }

    if (subcommand === "get") {
      const key = interaction.options.getString("key");
      if (key === null) {
        await interaction.reply({
          content: `Provide a key. Valid keys: ${CONFIGURABLE_KEYS.join(", ")}`,
          ephemeral: true,
        });
        return;
      }
      if (!CONFIGURABLE_KEYS.includes(key as ConfigKey)) {
        await interaction.reply({
          content: `Unknown key: \`${key}\`. Valid keys: ${CONFIGURABLE_KEYS.join(", ")}`,
          ephemeral: true,
        });
        return;
      }
      const val = formatConfigValue(config, key);
      await interaction.reply({ content: `**${key}**: ${val}`, ephemeral: true });
      return;
    }

    if (subcommand === "set") {
      const key = interaction.options.getString("key");
      const value = interaction.options.getString("value");

      if (key === null || value === null) {
        await interaction.reply({ content: "Both key and value are required.", ephemeral: true });
        return;
      }

      const error = validateConfigValue(key, value);
      if (error !== null) {
        await interaction.reply({ content: `Invalid value: ${error}`, ephemeral: true });
        return;
      }

      const updated = applyConfigValue(config, key, value);
      deps.updateGuildConfig(interaction.guildId, updated);

      await interaction.reply({
        content: `Updated **${key}** to: ${value}`,
        ephemeral: true,
      });
    }
  };
}
