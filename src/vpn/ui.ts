import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  AttachmentBuilder,
  type MessageEditOptions,
  type InteractionReplyOptions,
} from "discord.js";
import type { Peer, WgServer } from "./types.ts";
import type { VpnSession } from "./session.ts";
import { encodeCustomId } from "./session.ts";
import { peerToConfig } from "./config-builder.ts";
import { generateQr } from "./qr.ts";
import { generateZip } from "./zip.ts";

const PROFILE_CAP = 20;

const PROFILE_INFO = "**ВАЖНО**: вам нужен ОДИН профиль на ОДНО устройство. То есть, для смартфона и компьютера понадобится два отдельных профиля. В противном случае, VPN работать не будет.";

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
export function buildHomePanel(session: VpnSession): InteractionReplyOptions {
  const count = `${session.profiles.length}/${PROFILE_CAP} профилей`;
  const content = `## VPN панель\n${count}\n\n.`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "create_menu"))
      .setLabel("Создать профиль")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "list"))
      .setLabel("Показать профили")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "help"))
      .setLabel("Помощь")
      .setEmoji("\u{2753}")
      .setStyle(ButtonStyle.Secondary),
  );

  return { content, components: [row], ephemeral: true };
}

/** Build the help panel. */
export function buildHelpPanel(session: VpnSession): MessageEditOptions {
  const content = `# Помощь

## Как использовать VPN панель

### Установить клиент WireGuard
- [\u{1FA9F} Windows](<https://download.wireguard.com/windows-client/wireguard-installer.exe>)
- [\u{1F308} MacOS](<https://itunes.apple.com/us/app/wireguard/id1451685025?ls=1&mt=12>)
- [\u{1F916} Android](<https://play.google.com/store/apps/details?id=com.wireguard.android>)
- [\u{1F34F} iOS](<https://itunes.apple.com/us/app/wireguard/id1441195209?ls=1&mt=8>)

### Создать профиль

1. Нажмите кнопку «Создать профиль»
2. Выберите регион
3. Нажмите кнопку «Показать QR-код», чтобы отсканировать с мобильного клиента WireGuard
4. Нажмите кнопку «Скачать профиль», чтобы импортировать в WireGuard клиент на десктопе

### Блокировки

Несмотря на блокировку WireGuard в России, эти профили работают у большинства интернет провайдеров, в том числе мобильных. Секрет в том, что трафик проходит через виртуальную машину в России и передается на сервера в Европе.

### Почему WireGuard, а не vless/vmess/shadowsocks?
WireGuard в разы быстрее, обеспечивает наименьшую задержку, потребляет меньше ресурсов, бережнее обращается с аккумулятором телефона, проще в настройке и как правило вызывает меньше проблем

### Приватность и безопасность
Приватные ключи ваших профилей хранятся на той же машине, где лежит WireGuard сервер. Это сделано для упрощения работы с профилями.

.`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "home"))
      .setLabel("Назад")
      .setEmoji("\u{1F3E0}")
      .setStyle(ButtonStyle.Secondary),
  );

  return { content, components: [row], attachments: [] };
}

/** Build the server selection panel for creating a profile. */
export function buildCreatePanel(session: VpnSession): MessageEditOptions {
  const content = "## Выберите регион:\n\n.";

  const serverButtons = session.servers.slice(0, 4).map((server) =>
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "create", server.public_name))
      .setLabel(server.public_name)
      .setEmoji(getFlag(server.public_name))
      .setStyle(ButtonStyle.Primary),
  );

  const homeButton = new ButtonBuilder()
    .setCustomId(encodeCustomId(session.id, "home"))
    .setLabel("Назад")
    .setEmoji("\u{1F3E0}")
    .setStyle(ButtonStyle.Secondary);

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (serverButtons.length > 0) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...serverButtons));
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(homeButton));

  return { content, components: rows, attachments: [] };
}

/** Build the profile list panel. */
export function buildProfileListPanel(session: VpnSession): MessageEditOptions {
  const count = `${session.profiles.length}/${PROFILE_CAP}`;
  const content = `## Профили:\n${count}\n\n.`;

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  // Profile buttons (max 4 per row, max 4 rows for profiles = 16 profiles visible)
  const profileButtons = session.profiles.slice(0, 16).map((profile) => {
    const server = session.servers.find((s) => s.public_name === profile.server_name);
    return new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "manage", profile.name))
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
        .setLabel("Назад")
        .setEmoji("\u{1F3E0}")
        .setStyle(ButtonStyle.Secondary),
    ),
  );

  return { content, components: rows.slice(0, 5), attachments: [] };
}

/** Build the profile cap exceeded panel. */
export function buildCapExceededPanel(session: VpnSession): MessageEditOptions {
  const count = `${session.profiles.length}/${PROFILE_CAP}`;
  const content = `## Профили:\n${count}\n\n## Удалите лишние профили\n\n.`;

  return buildProfileListPanel({ ...session });
}

/** Build the manage profile panel. */
export function buildManageProfilePanel(session: VpnSession): MessageEditOptions {
  const profile = session.currentProfile;
  if (profile === null) {
    return { content: "Профиль не найден.", components: [], attachments: [] };
  }

  const content = `## Профиль "${profile.name}"\n\n${PROFILE_INFO}\n\n.`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "qr", profile.name))
      .setLabel("Показать QR-код")
      .setEmoji("\u{1F533}")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "download", profile.name))
      .setLabel("Скачать профиль")
      .setEmoji("\u{1F4BE}")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "delete", profile.name))
      .setLabel("Удалить")
      .setEmoji("\u{1F5D1}")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "list"))
      .setLabel("Назад")
      .setEmoji("\u{1F3E0}")
      .setStyle(ButtonStyle.Secondary),
  );

  return { content, components: [row], attachments: [] };
}

/** Build the QR code panel with attached image. */
export async function buildQrPanel(
  session: VpnSession,
  vpnPeer: string,
): Promise<MessageEditOptions> {
  const profile = session.currentProfile;
  const server = session.currentServer;
  if (profile === null || server === null) {
    return { content: "Профиль не найден.", components: [], attachments: [] };
  }

  const configText = peerToConfig(profile, server, vpnPeer);
  const qrBuffer = await generateQr(configText);
  const attachment = new AttachmentBuilder(qrBuffer, { name: "qr.png" });

  const content = `## Профиль "${profile.name}"

${PROFILE_INFO}

## Отсканируйте QR-код через мобильное приложение WireGuard

- [\u{1F916} Android](<https://play.google.com/store/apps/details?id=com.wireguard.android>)
- [\u{1F34F} iOS](<https://itunes.apple.com/us/app/wireguard/id1441195209?ls=1&mt=8>)

.`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "download", profile.name))
      .setLabel("Скачать профиль")
      .setEmoji("\u{1F4BE}")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "delete", profile.name))
      .setLabel("Удалить")
      .setEmoji("\u{1F5D1}")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "list"))
      .setLabel("Назад")
      .setEmoji("\u{1F3E0}")
      .setStyle(ButtonStyle.Secondary),
  );

  return { content, components: [row], files: [attachment] };
}

/** Build the download panel with attached zip. */
export function buildDownloadPanel(
  session: VpnSession,
  vpnPeer: string,
): MessageEditOptions {
  const profile = session.currentProfile;
  const server = session.currentServer;
  if (profile === null || server === null) {
    return { content: "Профиль не найден.", components: [], attachments: [] };
  }

  const configText = peerToConfig(profile, server, vpnPeer);
  const zipBuffer = generateZip(configText, `2b-${server.public_name}.conf`);
  const attachment = new AttachmentBuilder(zipBuffer, { name: `2b-${server.public_name}.zip` });

  const content = `## Профиль "${profile.name}"

${PROFILE_INFO}

## Скачайте приложенный файл и импортируйте в клиент WireGuard

- [\u{1FA9F} Windows](<https://download.wireguard.com/windows-client/wireguard-installer.exe>)
- [\u{1F308} MacOS](<https://itunes.apple.com/us/app/wireguard/id1451685025?ls=1&mt=12>)

.`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "qr", profile.name))
      .setLabel("Показать QR-код")
      .setEmoji("\u{1F533}")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "delete", profile.name))
      .setLabel("Удалить")
      .setEmoji("\u{1F5D1}")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "list"))
      .setLabel("Назад")
      .setEmoji("\u{1F3E0}")
      .setStyle(ButtonStyle.Secondary),
  );

  return { content, components: [row], files: [attachment] };
}

/** Build an error panel with a message. */
export function buildErrorPanel(session: VpnSession, errorMessage: string): MessageEditOptions {
  const content = `## Ошибка\n\n${errorMessage}\n\n.`;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(encodeCustomId(session.id, "home"))
      .setLabel("Назад")
      .setEmoji("\u{1F3E0}")
      .setStyle(ButtonStyle.Secondary),
  );

  return { content, components: [row], attachments: [] };
}

export { PROFILE_CAP };
