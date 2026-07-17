import {
  REST,
  Routes,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

export interface CommandRegistryOptions {
  token: string;
  clientId: string;
  commands: RESTPostAPIChatInputApplicationCommandsJSONBody[];
}

/**
 * Register slash commands globally via Discord REST API.
 * Returns the number of commands registered.
 */
export async function registerSlashCommands(
  opts: CommandRegistryOptions
): Promise<number> {
  const rest = new REST({ version: "10" }).setToken(opts.token);
  const body = opts.commands;
  const result = await rest.put(
    Routes.applicationCommands(opts.clientId),
    { body }
  );
  return Array.isArray(result) ? result.length : 0;
}

/** Register test-only commands in selected guilds for immediate, bounded availability. */
export async function registerGuildSlashCommands(
  opts: CommandRegistryOptions & { guildIds: string[] },
): Promise<number> {
  const rest = new REST({ version: "10" }).setToken(opts.token);
  let count = 0;
  for (const guildId of opts.guildIds) {
    const result = await rest.put(
      Routes.applicationGuildCommands(opts.clientId, guildId),
      { body: opts.commands },
    );
    count += Array.isArray(result) ? result.length : 0;
  }
  return count;
}
