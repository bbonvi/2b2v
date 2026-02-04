import { SlashCommandBuilder } from "discord.js";

/** /vpn command definition — open to all users. */
export const vpnCommandDefinition = new SlashCommandBuilder()
  .setName("vpn")
  .setDescription("Панель управления VPN профилями");
