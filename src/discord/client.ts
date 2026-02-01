import {
  Client,
  GatewayIntentBits,
  Partials,
  type ClientOptions,
} from "discord.js";
import type { GlobalConfig } from "../config/types.ts";

export const REQUIRED_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildEmojisAndStickers,
] as const;

/**
 * Check whether a message has readable content.
 * When the Message Content privileged intent is not granted, non-bot messages
 * arrive with empty string content. This helper detects that condition.
 */
export function checkMessageContentIntent(content: string | undefined): boolean {
  return content !== undefined && content !== "";
}

/** Build discord.js ClientOptions with required intents and partials. */
export function buildClientOptions(): ClientOptions {
  return {
    intents: [...REQUIRED_INTENTS],
    partials: [Partials.Message, Partials.Channel],
  };
}

let messageContentWarningEmitted = false;

/**
 * Create and configure the Discord client.
 * Does NOT call login — caller is responsible for that.
 */
export function createDiscordClient(config: GlobalConfig): Client {
  const client = new Client(buildClientOptions());

  client.once("ready", (c) => {
    console.log(
      JSON.stringify({
        level: "info",
        msg: "discord client ready",
        user: c.user.tag,
        guilds: c.guilds.cache.size,
        timestamp: new Date().toISOString(),
      })
    );
  });

  // Detect missing Message Content intent on first message with empty content
  client.on("messageCreate", (message) => {
    if (message.author.bot) return;
    if (!messageContentWarningEmitted && !checkMessageContentIntent(message.content)) {
      messageContentWarningEmitted = true;
      console.log(
        JSON.stringify({
          level: "warn",
          msg: "Message Content intent appears missing — message content is empty. Bot will operate in degraded mode.",
          timestamp: new Date().toISOString(),
        })
      );
    }
  });

  return client;
}

/** Login the Discord client. Throws on failure. */
export async function loginDiscordClient(
  client: Client,
  token: string
): Promise<void> {
  await client.login(token);
}
