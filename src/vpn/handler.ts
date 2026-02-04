import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import type { Logger } from "../logger.ts";
import type { VpnClient } from "./api-client.ts";
import type { SessionStore, VpnSession } from "./session.ts";
import { parseCustomId } from "./session.ts";
import { mapVpnError, VPN_ERRORS } from "./errors.ts";
import { logVpnCommand, logVpnApiError } from "./logger.ts";
import {
  buildHomePanel,
  buildHelpPanel,
  buildCreatePanel,
  buildProfileListPanel,
  buildManageProfilePanel,
  buildQrPanel,
  buildDownloadPanel,
  buildErrorPanel,
  PROFILE_CAP,
} from "./ui.ts";

export interface VpnHandlerDeps {
  client: VpnClient;
  sessionStore: SessionStore;
  vpnPeer: string;
  log: Logger;
}

/**
 * Handle the /vpn command invocation.
 */
export async function handleVpnCommand(
  interaction: ChatInputCommandInteraction,
  deps: VpnHandlerDeps,
): Promise<void> {
  const { client, sessionStore, log } = deps;
  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  // Guild-only check
  if (guildId === null) {
    await interaction.reply({ content: VPN_ERRORS.NOT_IN_GUILD, ephemeral: true });
    return;
  }

  logVpnCommand(log, "invoke", userId, guildId);

  try {
    // Fetch or create user
    let user = await client.getUser(userId);
    if (user === null) {
      user = await client.createUser(userId, interaction.user.username);
    }

    // Fetch servers and profiles
    const [servers, profiles] = await Promise.all([
      client.listServers(),
      client.listProfiles(userId),
    ]);

    // Create session
    const session = sessionStore.create(userId, guildId);
    session.servers = servers;
    session.profiles = profiles;

    // Reply with home panel
    await interaction.reply(buildHomePanel(session));
  } catch (err) {
    logVpnApiError(log, err as Parameters<typeof logVpnApiError>[1], userId, guildId);
    await interaction.reply({ content: mapVpnError(err), ephemeral: true });
  }
}

/**
 * Handle a VPN component interaction (button/select).
 * Returns true if the interaction was handled, false if it's not a VPN interaction.
 */
export async function handleVpnComponent(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  deps: VpnHandlerDeps,
): Promise<boolean> {
  const { client, sessionStore, vpnPeer, log } = deps;
  const parsed = parseCustomId(interaction.customId);
  if (parsed === null) {
    return false; // Not a VPN interaction
  }

  const { sessionId, action, param } = parsed;
  const userId = interaction.user.id;
  const guildId = interaction.guildId ?? "";

  // Session lookup
  const session = sessionStore.get(sessionId);
  if (session === undefined) {
    await interaction.reply({ content: VPN_ERRORS.SESSION_EXPIRED, ephemeral: true });
    return true;
  }

  // User gating
  if (!sessionStore.isOwner(sessionId, userId)) {
    await interaction.reply({ content: VPN_ERRORS.USER_MISMATCH, ephemeral: true });
    return true;
  }

  try {
    switch (action) {
      case "home": {
        // Refresh profiles and show home
        session.profiles = await client.listProfiles(userId);
        await interaction.update(buildHomePanel(session) as Parameters<typeof interaction.update>[0]);
        break;
      }

      case "help": {
        await interaction.update(buildHelpPanel(session));
        break;
      }

      case "create_menu": {
        // Check cap before showing create menu
        if (session.profiles.length >= PROFILE_CAP) {
          await interaction.update(buildProfileListPanel(session));
        } else {
          await interaction.update(buildCreatePanel(session));
        }
        break;
      }

      case "create": {
        // Create profile on server specified by param
        if (param === undefined) {
          await interaction.update(buildErrorPanel(session, "Сервер не указан."));
          break;
        }

        // Double-check cap
        if (session.profiles.length >= PROFILE_CAP) {
          await interaction.update(buildErrorPanel(session, VPN_ERRORS.PROFILE_LIMIT));
          break;
        }

        logVpnCommand(log, "create", userId, guildId, { server: param });

        const newProfile = await client.createProfile(userId, param);
        session.profiles = await client.listProfiles(userId);
        session.currentProfile = newProfile;
        session.currentServer = session.servers.find((s) => s.public_name === param) ?? null;

        await interaction.update(buildManageProfilePanel(session));
        break;
      }

      case "list": {
        session.profiles = await client.listProfiles(userId);
        session.currentProfile = null;
        session.currentServer = null;
        await interaction.update(buildProfileListPanel(session));
        break;
      }

      case "manage": {
        // Show manage panel for profile specified by param
        if (param === undefined) {
          await interaction.update(buildErrorPanel(session, "Профиль не указан."));
          break;
        }

        const profile = session.profiles.find((p) => p.name === param);
        if (profile === undefined) {
          await interaction.update(buildErrorPanel(session, "Профиль не найден."));
          break;
        }

        session.currentProfile = profile;
        session.currentServer = session.servers.find((s) => s.public_name === profile.server_name) ?? null;
        await interaction.update(buildManageProfilePanel(session));
        break;
      }

      case "qr": {
        // Show QR for current profile
        if (param === undefined) {
          await interaction.update(buildErrorPanel(session, "Профиль не указан."));
          break;
        }

        const profile = session.profiles.find((p) => p.name === param);
        if (profile === undefined) {
          await interaction.update(buildErrorPanel(session, "Профиль не найден."));
          break;
        }

        session.currentProfile = profile;
        session.currentServer = session.servers.find((s) => s.public_name === profile.server_name) ?? null;

        logVpnCommand(log, "qr", userId, guildId, { profile: profile.name });
        const qrPanel = await buildQrPanel(session, vpnPeer);
        await interaction.update(qrPanel as Parameters<typeof interaction.update>[0]);
        break;
      }

      case "download": {
        // Show download for current profile
        if (param === undefined) {
          await interaction.update(buildErrorPanel(session, "Профиль не указан."));
          break;
        }

        const profile = session.profiles.find((p) => p.name === param);
        if (profile === undefined) {
          await interaction.update(buildErrorPanel(session, "Профиль не найден."));
          break;
        }

        session.currentProfile = profile;
        session.currentServer = session.servers.find((s) => s.public_name === profile.server_name) ?? null;

        logVpnCommand(log, "download", userId, guildId, { profile: profile.name });
        const downloadPanel = buildDownloadPanel(session, vpnPeer);
        await interaction.update(downloadPanel as Parameters<typeof interaction.update>[0]);
        break;
      }

      case "delete": {
        // Delete profile specified by param
        if (param === undefined) {
          await interaction.update(buildErrorPanel(session, "Профиль не указан."));
          break;
        }

        const profile = session.profiles.find((p) => p.name === param);
        if (profile === undefined) {
          await interaction.update(buildErrorPanel(session, "Профиль не найден."));
          break;
        }

        logVpnCommand(log, "delete", userId, guildId, { profile: profile.name });
        await client.deleteProfile(profile.server_name, profile.address);
        session.profiles = await client.listProfiles(userId);
        session.currentProfile = null;
        session.currentServer = null;

        await interaction.update(buildProfileListPanel(session));
        break;
      }

      default: {
        await interaction.update(buildErrorPanel(session, "Неизвестное действие."));
      }
    }
  } catch (err) {
    logVpnApiError(log, err as Parameters<typeof logVpnApiError>[1], userId, guildId);
    try {
      await interaction.update(buildErrorPanel(session, mapVpnError(err)));
    } catch {
      // If update fails, try reply
      await interaction.reply({ content: mapVpnError(err), ephemeral: true }).catch(() => {});
    }
  }

  return true;
}
