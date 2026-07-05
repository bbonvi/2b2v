import type { QdrantClient } from "@qdrant/js-client-rest";
import { MessageFlags, type ChatInputCommandInteraction, type Client } from "discord.js";
import { createMemoryWipeHandler } from "../commands/memory-wipe";
import { createScheduleHandler } from "../commands/schedule";
import { createStatusHandler } from "../commands/status";
import { cleanupGuildData, cleanupRecentMessages } from "../db/message-cleanup";
import type { Database } from "../db/database";
import { createSchedule, deleteScheduleForGuild, listSchedules } from "../db/schedule-repository";
import type { SchedulerEngine } from "../scheduler/engine";
import type { GlobalConfig, GuildConfig } from "../config/types";
import type { Logger } from "../logger";
import { getVpnLocale } from "../vpn/i18n";
import { handleVpnCommand, handleVpnComponent, type VpnHandlerDeps } from "../vpn/handler";
import type { VpnClient } from "../vpn/api-client";
import type { SessionStore } from "../vpn/session";

type CommandHandler = (interaction: ChatInputCommandInteraction) => Promise<void>;

export function registerInteractionRuntime(input: {
  client: Client;
  db: Database;
  qdrant: QdrantClient;
  scheduler: SchedulerEngine;
  getGlobalConfig: () => GlobalConfig;
  getGuildConfig: (guildId: string) => GuildConfig;
  vpnClient: VpnClient | null;
  vpnSessionStore: SessionStore;
  vpnEnabled: boolean;
  startTime: number;
  log: Logger;
}): void {
  const commandHandlers = new Map<string, CommandHandler>();

  function vpnDeps(): VpnHandlerDeps {
    const globalConfig = input.getGlobalConfig();
    return {
      client: input.vpnClient,
      sessionStore: input.vpnSessionStore,
      vpnPeer: globalConfig.vpn?.vpnPeer ?? "",
      log: input.log.child({ component: "vpn" }),
      locale: getVpnLocale(globalConfig.uiLang),
      enabled: input.vpnEnabled,
    };
  }

  function setupCommandHandlers(guildId: string): void {
    const config = input.getGuildConfig(guildId);

    commandHandlers.set("status", createStatusHandler({
      getStats: () => ({
        uptimeMs: Date.now() - input.startTime,
        guildCount: input.client.guilds.cache.size,
        messageCount: (input.db.raw.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c,
        memoryCount: (input.db.raw.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c,
        scheduleCount: (input.db.raw.prepare("SELECT COUNT(*) as c FROM schedules WHERE enabled = 1").get() as { c: number }).c,
      }),
      adminUserIds: config.adminUserIds,
    }));

    commandHandlers.set("schedule", createScheduleHandler({
      listSchedules: (filter) => listSchedules(input.db, filter),
      createSchedule: (scheduleInput) => createSchedule(input.db, scheduleInput),
      deleteSchedule: (id, targetGuildId) => deleteScheduleForGuild(input.db, id, targetGuildId),
      onScheduleCreated: (id) => input.scheduler.addSchedule(id),
      onScheduleRemoved: (id) => input.scheduler.removeSchedule(id),
      adminUserIds: config.adminUserIds,
      getGuildTimezone: (gId) => input.getGuildConfig(gId).timezone,
    }));

    commandHandlers.set("memory-wipe", createMemoryWipeHandler({
      wipeGuild: (gId) => cleanupGuildData({ db: input.db, qdrant: input.qdrant, guildId: gId }),
      wipeRecent: async (_gId, chId, count) => {
        return await cleanupRecentMessages({ db: input.db, qdrant: input.qdrant, guildId: _gId, channelId: chId, count });
      },
      adminUserIds: config.adminUserIds,
    }));
  }

  input.client.on("interactionCreate", (interaction) => void (async () => {
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      try {
        const handled = await handleVpnComponent(interaction, vpnDeps());
        if (!handled) {
          input.log.warn("unknown component interaction", { customId: interaction.customId });
        }
      } catch (err) {
        input.log.error("component interaction error", {
          customId: interaction.customId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "vpn") {
      try {
        await handleVpnCommand(interaction, vpnDeps());
      } catch (err) {
        input.log.error("vpn command error", {
          guildId: interaction.guildId,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: "Произошла ошибка.", flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      }
      return;
    }

    if (interaction.guildId === null) return;
    setupCommandHandlers(interaction.guildId);

    const handler = commandHandlers.get(interaction.commandName);
    if (handler === undefined) return;

    try {
      await handler(interaction);
    } catch (err) {
      input.log.error("command handler error", {
        command: interaction.commandName,
        guildId: interaction.guildId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "An error occurred.", flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  })());
}
