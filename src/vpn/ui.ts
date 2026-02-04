import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  type MessageEditOptions,
} from "discord.js";
import type { Peer } from "./types.ts";
import type { VpnSession } from "./session.ts";
import { encodeCustomId } from "./session.ts";
import { peerToConfig } from "./config-builder.ts";
import { generateQr } from "./qr.ts";
import { generateZip } from "./zip.ts";
import { PROFILE_CAP, type VpnLocale } from "./i18n.ts";

/** Encode a profile identifier for use in customId. Format: server_name|address */
export function encodeProfileId(profile: Peer): string {
  return `${profile.server_name}|${profile.address}`;
}

/** Decode a profile identifier and find matching profile. Returns undefined if not found. */
export function decodeProfileId(profiles: Peer[], profileId: string): Peer | undefined {
  const [serverName, address] = profileId.split("|");
  return profiles.find((p) => p.server_name === serverName && p.address === address);
}

/** Get flag emoji for a server region. */
export function getFlag(serverName: string): string {
  const name = serverName.toLowerCase();
  if (name.includes("finland")) return "\u{1F1EB}\u{1F1EE}";
  if (name.includes("netherlands") || name.includes("amsterdam")) return "\u{1F1F3}\u{1F1F1}";
  if (name.includes("france")) return "\u{1F1EB}\u{1F1F7}";
  if (name.includes("germany")) return "\u{1F1E9}\u{1F1EA}";
  return "\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}";
}

/** Build the home panel (main menu). */
export function buildHomePanel(session: VpnSession, locale: VpnLocale): MessageEditOptions {
  const count = locale.profileCount(session.profiles.length, PROFILE_CAP);
  const content = `## ${locale.panelTitle}\n${count}\n\n.`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "create_menu"))
      .setLabel(locale.createProfile)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "list"))
      .setLabel(locale.showProfiles)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "help"))
      .setLabel(locale.help)
      .setEmoji("\u{2753}")
      .setStyle(ButtonStyle.Secondary),
  );

  return { content, components: [row], attachments: [] };
}

/** Build the help panel. */
export function buildHelpPanel(session: VpnSession, locale: VpnLocale): MessageEditOptions {
  const content = `# ${locale.helpTitle}

## How to use VPN panel

### ${locale.helpInstallClient}
- [\u{1FA9F} ${locale.clientWindows}](<https://download.wireguard.com/windows-client/wireguard-installer.exe>)
- [\u{1F308} ${locale.clientMacOS}](<https://itunes.apple.com/us/app/wireguard/id1451685025?ls=1&mt=12>)
- [\u{1F916} ${locale.clientAndroid}](<https://play.google.com/store/apps/details?id=com.wireguard.android>)
- [\u{1F34F} ${locale.clientiOS}](<https://itunes.apple.com/us/app/wireguard/id1441195209?ls=1&mt=8>)

### ${locale.createProfile}

${locale.helpCreateProfile}

### Blocking

${locale.helpBlocking}

### Why WireGuard?
${locale.helpWhyWireguard}

### Privacy and Security
${locale.helpPrivacy}

.`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "home"))
      .setLabel(locale.back)
      .setEmoji("\u{1F3E0}")
      .setStyle(ButtonStyle.Secondary),
  );

  return { content, components: [row], attachments: [] };
}

/** Build the server selection panel for creating a profile. */
export function buildCreatePanel(session: VpnSession, locale: VpnLocale): MessageEditOptions {
  const content = `## ${locale.selectRegion}\n\n.`;

  // Max 20 servers (4 rows × 5 buttons), 1 row reserved for back button
  const serverButtons = session.servers.slice(0, 20).map((server) =>
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "create", server.public_name))
      .setLabel(server.public_name)
      .setEmoji(getFlag(server.public_name))
      .setStyle(ButtonStyle.Primary),
  );

  const homeButton = new ButtonBuilder()
    .setCustomId(encodeCustomId(session.id, "home"))
    .setLabel(locale.back)
    .setEmoji("\u{1F3E0}")
    .setStyle(ButtonStyle.Secondary);

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  // Split server buttons into rows of 5
  for (let i = 0; i < serverButtons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...serverButtons.slice(i, i + 5)));
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(homeButton));

  return { content, components: rows.slice(0, 5), attachments: [] };
}

/** Build the profile list panel. */
export function buildProfileListPanel(session: VpnSession, locale: VpnLocale): MessageEditOptions {
  const count = locale.profileCount(session.profiles.length, PROFILE_CAP);
  const content = `## ${locale.profilesTitle}\n${count}\n\n.`;

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  // Profile buttons (max 4 per row, max 4 rows for profiles = 16 profiles visible)
  const profileButtons = session.profiles.slice(0, 16).map((profile) => {
    const server = session.servers.find((s) => s.public_name === profile.server_name);
    return new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "manage", encodeProfileId(profile)))
      .setLabel(profile.name)
      .setEmoji(server !== undefined ? getFlag(server.public_name) : "\u{1F4C1}")
      .setStyle(ButtonStyle.Primary);
  });

  // Split into rows of 4
  for (let i = 0; i < profileButtons.length; i += 4) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...profileButtons.slice(i, i + 4)));
  }

  // Home button
  rows.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(encodeCustomId(session.id, "home"))
        .setLabel(locale.back)
        .setEmoji("\u{1F3E0}")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  return { content, components: rows.slice(0, 5), attachments: [] };
}

/** Build the manage profile panel. */
export function buildManageProfilePanel(session: VpnSession, locale: VpnLocale): MessageEditOptions {
  const profile = session.currentProfile;
  if (profile === null) {
    return { content: locale.profileNotFound, components: [], attachments: [] };
  }

  const content = `## Profile "${profile.name}"\n\n${locale.profileInfo}\n\n.`;

  const profileId = encodeProfileId(profile);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "qr", profileId))
      .setLabel(locale.showQrCode)
      .setEmoji("\u{1F533}")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "download", profileId))
      .setLabel(locale.downloadProfile)
      .setEmoji("\u{1F4BE}")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "delete", profileId))
      .setLabel(locale.delete)
      .setEmoji("\u{1F5D1}")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "list"))
      .setLabel(locale.back)
      .setEmoji("\u{1F3E0}")
      .setStyle(ButtonStyle.Secondary),
  );

  return { content, components: [row], attachments: [] };
}

/** Build the QR code panel with attached image. */
export async function buildQrPanel(
  session: VpnSession,
  vpnPeer: string,
  locale: VpnLocale,
): Promise<MessageEditOptions> {
  const profile = session.currentProfile;
  const server = session.currentServer;
  if (profile === null || server === null) {
    return { content: locale.profileNotFound, components: [], attachments: [] };
  }

  const configText = peerToConfig(profile, server, vpnPeer);
  const qrBuffer = await generateQr(configText);
  const attachment = new AttachmentBuilder(qrBuffer, { name: "qr.png" });

  const content = `## Profile "${profile.name}"

${locale.profileInfo}

## ${locale.scanQrInstruction}

- [\u{1F916} ${locale.clientAndroid}](<https://play.google.com/store/apps/details?id=com.wireguard.android>)
- [\u{1F34F} ${locale.clientiOS}](<https://itunes.apple.com/us/app/wireguard/id1441195209?ls=1&mt=8>)

.`;

  const profileId = encodeProfileId(profile);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "download", profileId))
      .setLabel(locale.downloadProfile)
      .setEmoji("\u{1F4BE}")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "delete", profileId))
      .setLabel(locale.delete)
      .setEmoji("\u{1F5D1}")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "list"))
      .setLabel(locale.back)
      .setEmoji("\u{1F3E0}")
      .setStyle(ButtonStyle.Secondary),
  );

  return { content, components: [row], files: [attachment] };
}

/** Build the download panel with attached zip. */
export function buildDownloadPanel(
  session: VpnSession,
  vpnPeer: string,
  locale: VpnLocale,
): MessageEditOptions {
  const profile = session.currentProfile;
  const server = session.currentServer;
  if (profile === null || server === null) {
    return { content: locale.profileNotFound, components: [], attachments: [] };
  }

  const configText = peerToConfig(profile, server, vpnPeer);
  const zipBuffer = generateZip(configText, `2b-${server.public_name}.conf`);
  const attachment = new AttachmentBuilder(zipBuffer, { name: `2b-${server.public_name}.zip` });

  const content = `## Profile "${profile.name}"

${locale.profileInfo}

## ${locale.downloadInstruction}

- [\u{1FA9F} ${locale.clientWindows}](<https://download.wireguard.com/windows-client/wireguard-installer.exe>)
- [\u{1F308} ${locale.clientMacOS}](<https://itunes.apple.com/us/app/wireguard/id1451685025?ls=1&mt=12>)

.`;

  const profileId = encodeProfileId(profile);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "qr", profileId))
      .setLabel(locale.showQrCode)
      .setEmoji("\u{1F533}")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "delete", profileId))
      .setLabel(locale.delete)
      .setEmoji("\u{1F5D1}")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "list"))
      .setLabel(locale.back)
      .setEmoji("\u{1F3E0}")
      .setStyle(ButtonStyle.Secondary),
  );

  return { content, components: [row], files: [attachment] };
}

/** Build an error panel with a message. */
export function buildErrorPanel(session: VpnSession, errorMessage: string, locale: VpnLocale): MessageEditOptions {
  const content = `## ${locale.errorTitle}\n\n${errorMessage}\n\n.`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "home"))
      .setLabel(locale.back)
      .setEmoji("\u{1F3E0}")
      .setStyle(ButtonStyle.Secondary),
  );

  return { content, components: [row], attachments: [] };
}

export { PROFILE_CAP };
