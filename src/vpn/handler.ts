import type {
  ChatInputCommandInteraction,
  ButtonInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import type { Logger } from "../logger.ts";
import type { VpnClient } from "./api-client.ts";
import type { SessionStore } from "./session.ts";
import { parseCustomId } from "./session.ts";
import { mapVpnError } from "./errors.ts";
import { logVpnCommand, logVpnApiError } from "./logger.ts";
import type { VpnLocale } from "./i18n.ts";
import {
  buildHomePanel,
  buildHelpPanel,
  buildCreatePanel,
  buildProfileListPanel,
  buildManageProfilePanel,
  buildQrPanel,
  buildDownloadPanel,
  buildErrorPanel,
  decodeProfileId,
  PROFILE_CAP,
} from "./ui.ts";

export interface VpnHandlerDeps {
  client: VpnClient | null;
  sessionStore: SessionStore;
  vpnPeer: string;
  log: Logger;
  locale: VpnLocale;
  enabled: boolean;
}

/**
 * Handle the /vpn command invocation.
 */
export async function handleVpnCommand(
  interaction: ChatInputCommandInteraction,
  deps: VpnHandlerDeps,
): Promise<void> {
  const { client, sessionStore, log, locale, enabled } = deps;
  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  // Guild-only check
  if (guildId === null) {
    await interaction.reply({ content: locale.notInGuild, ephemeral: true });
    return;
  }

  // Enabled check
  if (!enabled || client === null) {
    await interaction.reply({ content: locale.vpnDisabled, ephemeral: true });
    return;
  }

  logVpnCommand(log, "invoke", userId, guildId);

  // Defer reply immediately — VPN API calls may be slow
  await interaction.deferReply({ ephemeral: true });

  try {
    // Ensure user exists
    const _user = await client.getUser(userId) ?? await client.createUser(userId, interaction.user.username);

    // Fetch servers and profiles
    const [servers, profiles] = await Promise.all([
      client.listServers(),
      client.listProfiles(userId),
    ]);

    // Create session
    const session = sessionStore.create(userId, guildId);
    session.servers = servers;
    session.profiles = profiles;

    // Edit the deferred reply with home panel
    await interaction.editReply(buildHomePanel(session, locale));
  } catch (err) {
    logVpnApiError(log, err as Parameters<typeof logVpnApiError>[1], userId, guildId);
    await interaction.editReply({ content: mapVpnError(err, locale) });
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
  const { client, sessionStore, vpnPeer, log, locale, enabled } = deps;
  const parsed = parseCustomId(interaction.customId);
  if (parsed === null) {
    return false; // Not a VPN interaction
  }

  const { sessionId, action, param } = parsed;
  const userId = interaction.user.id;
  const guildId = interaction.guildId ?? "";

  // Enabled check
  if (!enabled || client === null) {
    await interaction.reply({ content: locale.vpnDisabled, ephemeral: true });
    return true;
  }

  // Session lookup
  const session = sessionStore.get(sessionId);
  if (session === undefined) {
    await interaction.reply({ content: locale.sessionExpired, ephemeral: true });
    return true;
  }

  // User gating
  if (!sessionStore.isOwner(sessionId, userId)) {
    await interaction.reply({ content: locale.userMismatch, ephemeral: true });
    return true;
  }

  // Defer update for actions with API calls; instant actions can use update() directly
  const needsDefer = ["home", "create", "list", "delete"].includes(action);
  if (needsDefer) {
    await interaction.deferUpdate();
  }

  try {
    switch (action) {
      case "home": {
        // Refresh profiles and show home (deferred)
        session.profiles = await client.listProfiles(userId);
        await interaction.editReply(buildHomePanel(session, locale));
        break;
      }

      case "help": {
        await interaction.update(buildHelpPanel(session, locale));
        break;
      }

      case "create_menu": {
        // Check cap before showing create menu
        if (session.profiles.length >= PROFILE_CAP) {
          await interaction.update(buildProfileListPanel(session, locale));
        } else {
          await interaction.update(buildCreatePanel(session, locale));
        }
        break;
      }

      case "create": {
        // Create profile on server specified by param (deferred)
        if (param === undefined) {
          await interaction.editReply(buildErrorPanel(session, locale.serverNotSpecified, locale));
          break;
        }

        // Double-check cap
        if (session.profiles.length >= PROFILE_CAP) {
          await interaction.editReply(buildErrorPanel(session, locale.profileLimit, locale));
          break;
        }

        logVpnCommand(log, "create", userId, guildId, { server: param });

        const newProfile = await client.createProfile(userId, param);
        session.profiles = await client.listProfiles(userId);
        session.currentProfile = newProfile;
        session.currentServer = session.servers.find((s) => s.public_name === param) ?? null;

        await interaction.editReply(buildManageProfilePanel(session, locale));
        break;
      }

      case "list": {
        // Refresh profiles (deferred)
        session.profiles = await client.listProfiles(userId);
        session.currentProfile = null;
        session.currentServer = null;
        await interaction.editReply(buildProfileListPanel(session, locale));
        break;
      }

      case "manage": {
        // Show manage panel for profile specified by param (server_name|address)
        if (param === undefined) {
          await interaction.update(buildErrorPanel(session, locale.profileNotSpecified, locale));
          break;
        }

        const profile = decodeProfileId(session.profiles, param);
        if (profile === undefined) {
          await interaction.update(buildErrorPanel(session, locale.profileNotFound, locale));
          break;
        }

        session.currentProfile = profile;
        session.currentServer = session.servers.find((s) => s.public_name === profile.server_name) ?? null;
        await interaction.update(buildManageProfilePanel(session, locale));
        break;
      }

      case "qr": {
        // Show QR for current profile (param is server_name|address)
        if (param === undefined) {
          await interaction.update(buildErrorPanel(session, locale.profileNotSpecified, locale));
          break;
        }

        const profile = decodeProfileId(session.profiles, param);
        if (profile === undefined) {
          await interaction.update(buildErrorPanel(session, locale.profileNotFound, locale));
          break;
        }

        session.currentProfile = profile;
        session.currentServer = session.servers.find((s) => s.public_name === profile.server_name) ?? null;

        logVpnCommand(log, "qr", userId, guildId, { profile: profile.name });
        const qrPanel = await buildQrPanel(session, vpnPeer, locale);
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- type cast, not deprecated usage
        await interaction.update(qrPanel as Parameters<typeof interaction.update>[0]);
        break;
      }

      case "download": {
        // Show download for current profile (param is server_name|address)
        if (param === undefined) {
          await interaction.update(buildErrorPanel(session, locale.profileNotSpecified, locale));
          break;
        }

        const profile = decodeProfileId(session.profiles, param);
        if (profile === undefined) {
          await interaction.update(buildErrorPanel(session, locale.profileNotFound, locale));
          break;
        }

        session.currentProfile = profile;
        session.currentServer = session.servers.find((s) => s.public_name === profile.server_name) ?? null;

        logVpnCommand(log, "download", userId, guildId, { profile: profile.name });
        const downloadPanel = buildDownloadPanel(session, vpnPeer, locale);
        // eslint-disable-next-line @typescript-eslint/no-deprecated -- type cast, not deprecated usage
        await interaction.update(downloadPanel as Parameters<typeof interaction.update>[0]);
        break;
      }

      case "delete": {
        // Delete profile specified by param (server_name|address, deferred)
        if (param === undefined) {
          await interaction.editReply(buildErrorPanel(session, locale.profileNotSpecified, locale));
          break;
        }

        const profile = decodeProfileId(session.profiles, param);
        if (profile === undefined) {
          await interaction.editReply(buildErrorPanel(session, locale.profileNotFound, locale));
          break;
        }

        logVpnCommand(log, "delete", userId, guildId, { profile: profile.name });
        await client.deleteProfile(profile.server_name, profile.address);
        session.profiles = await client.listProfiles(userId);
        session.currentProfile = null;
        session.currentServer = null;

        await interaction.editReply(buildProfileListPanel(session, locale));
        break;
      }

      default: {
        await interaction.update(buildErrorPanel(session, locale.unknownAction, locale));
      }
    }
  } catch (err) {
    logVpnApiError(log, err as Parameters<typeof logVpnApiError>[1], userId, guildId);
    const errorPanel = buildErrorPanel(session, mapVpnError(err, locale), locale);
    if (needsDefer) {
      await interaction.editReply(errorPanel).catch(() => {});
    } else {
      await interaction.update(errorPanel).catch(() =>
        interaction.reply({ content: mapVpnError(err, locale), ephemeral: true }).catch(() => {}),
      );
    }
  }

  return true;
}
