import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import type { VoiceRuntime } from "../voice/runtime.ts";

export const voiceTestCommandDefinition = new SlashCommandBuilder()
  .setName("voice")
  .setDescription("Inject a test line into 2B's current voice session")
  .addStringOption((option) => option
    .setName("text")
    .setDescription("Text interpreted exactly like a finalized spoken line")
    .setRequired(true)
    .setMaxLength(2000));

/** Restricted test command that enters the normal post-STT voice pipeline. */
export async function handleVoiceTestCommand(
  interaction: ChatInputCommandInteraction,
  runtime: VoiceRuntime,
): Promise<void> {
  if (interaction.guildId === null) return;
  const text = interaction.options.getString("text", true);
  const trusted = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true;
  const segment = await runtime.inject({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    username: interaction.user.username,
    text,
    trusted,
  });
  await interaction.reply({
    content: `Injected voice segment ${segment.id}.`,
    flags: MessageFlags.Ephemeral,
  });
}
