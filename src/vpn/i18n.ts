import type { UiLang } from "../config/types.ts";

/** Maximum profiles per user. */
export const PROFILE_CAP = 16;

/** VPN UI locale strings. */
export interface VpnLocale {
  // Panel titles and labels
  panelTitle: string;
  profileCount: (current: number, max: number) => string;
  createProfile: string;
  showProfiles: string;
  help: string;
  back: string;
  selectRegion: string;
  profilesTitle: string;
  profileInfo: string;
  showQrCode: string;
  downloadProfile: string;
  delete: string;
  scanQrInstruction: string;
  downloadInstruction: string;
  errorTitle: string;
  profileNotFound: string;

  // Help panel
  helpTitle: string;
  helpInstallClient: string;
  helpCreateProfile: string;
  helpBlocking: string;
  helpWhyWireguard: string;
  helpPrivacy: string;

  // Client download links (shared, but section headers differ)
  clientWindows: string;
  clientMacOS: string;
  clientAndroid: string;
  clientiOS: string;

  // Errors
  timeout: string;
  serverError: string;
  networkError: string;
  unknown: string;
  profileLimit: string;
  userMismatch: string;
  sessionExpired: string;
  notInGuild: string;
  vpnDisabled: string;
  serverNotSpecified: string;
  profileNotSpecified: string;
  unknownAction: string;
}

const ru: VpnLocale = {
  // Panel titles and labels
  panelTitle: "VPN панель",
  profileCount: (current, max) => `${current}/${max} профилей`,
  createProfile: "Создать профиль",
  showProfiles: "Показать профили",
  help: "Помощь",
  back: "Назад",
  selectRegion: "Выберите регион:",
  profilesTitle: "Профили:",
  profileInfo: "**ВАЖНО**: вам нужен ОДИН профиль на ОДНО устройство. То есть, для смартфона и компьютера понадобится два отдельных профиля. В противном случае, VPN работать не будет.",
  showQrCode: "Показать QR-код",
  downloadProfile: "Скачать профиль",
  delete: "Удалить",
  scanQrInstruction: "Отсканируйте QR-код через мобильное приложение WireGuard",
  downloadInstruction: "Скачайте приложенный файл и импортируйте в клиент WireGuard",
  errorTitle: "Ошибка",
  profileNotFound: "Профиль не найден.",

  // Help panel
  helpTitle: "Помощь",
  helpInstallClient: "Установить клиент WireGuard",
  helpCreateProfile: `1. Нажмите кнопку «Создать профиль»
2. Выберите регион
3. Нажмите кнопку «Показать QR-код», чтобы отсканировать с мобильного клиента WireGuard
4. Нажмите кнопку «Скачать профиль», чтобы импортировать в WireGuard клиент на десктопе`,
  helpBlocking: "Несмотря на блокировку WireGuard в России, эти профили работают у большинства интернет провайдеров, в том числе мобильных. Секрет в том, что трафик проходит через виртуальную машину в России и передается на сервера в Европе.",
  helpWhyWireguard: "WireGuard в разы быстрее, обеспечивает наименьшую задержку, потребляет меньше ресурсов, бережнее обращается с аккумулятором телефона, проще в настройке и как правило вызывает меньше проблем",
  helpPrivacy: "Приватные ключи ваших профилей хранятся на той же машине, где лежит WireGuard сервер. Это сделано для упрощения работы с профилями.",

  // Client links
  clientWindows: "Windows",
  clientMacOS: "MacOS",
  clientAndroid: "Android",
  clientiOS: "iOS",

  // Errors
  timeout: "Сервер VPN не отвечает. Попробуйте позже.",
  serverError: "Ошибка сервера VPN. Попробуйте позже.",
  networkError: "Не удалось связаться с сервером VPN.",
  unknown: "Произошла неизвестная ошибка.",
  profileLimit: `Достигнут лимит профилей (${PROFILE_CAP}). Удалите один из существующих.`,
  userMismatch: "Эта панель принадлежит другому пользователю.",
  sessionExpired: "Сессия истекла. Используйте /vpn снова.",
  notInGuild: "Команда /vpn доступна только на сервере.",
  vpnDisabled: "VPN отключен на этом сервере.",
  serverNotSpecified: "Сервер не указан.",
  profileNotSpecified: "Профиль не указан.",
  unknownAction: "Неизвестное действие.",
};

const en: VpnLocale = {
  // Panel titles and labels
  panelTitle: "VPN Panel",
  profileCount: (current, max) => `${current}/${max} profiles`,
  createProfile: "Create Profile",
  showProfiles: "Show Profiles",
  help: "Help",
  back: "Back",
  selectRegion: "Select region:",
  profilesTitle: "Profiles:",
  profileInfo: "**IMPORTANT**: you need ONE profile per ONE device. That is, for a smartphone and a computer you will need two separate profiles. Otherwise, VPN will not work.",
  showQrCode: "Show QR Code",
  downloadProfile: "Download Profile",
  delete: "Delete",
  scanQrInstruction: "Scan the QR code with the WireGuard mobile app",
  downloadInstruction: "Download the attached file and import it into the WireGuard client",
  errorTitle: "Error",
  profileNotFound: "Profile not found.",

  // Help panel
  helpTitle: "Help",
  helpInstallClient: "Install WireGuard client",
  helpCreateProfile: `1. Click the "Create Profile" button
2. Select a region
3. Click "Show QR Code" to scan with the WireGuard mobile client
4. Click "Download Profile" to import into the desktop WireGuard client`,
  helpBlocking: "Despite WireGuard being blocked in Russia, these profiles work with most internet providers, including mobile ones. The secret is that traffic passes through a virtual machine in Russia and is forwarded to servers in Europe.",
  helpWhyWireguard: "WireGuard is much faster, provides the lowest latency, consumes fewer resources, is gentler on phone battery, easier to set up, and generally causes fewer problems",
  helpPrivacy: "The private keys of your profiles are stored on the same machine as the WireGuard server. This is done to simplify profile management.",

  // Client links
  clientWindows: "Windows",
  clientMacOS: "MacOS",
  clientAndroid: "Android",
  clientiOS: "iOS",

  // Errors
  timeout: "VPN server is not responding. Please try again later.",
  serverError: "VPN server error. Please try again later.",
  networkError: "Could not connect to the VPN server.",
  unknown: "An unknown error occurred.",
  profileLimit: `Profile limit reached (${PROFILE_CAP}). Delete an existing one.`,
  userMismatch: "This panel belongs to another user.",
  sessionExpired: "Session expired. Use /vpn again.",
  notInGuild: "/vpn command is only available in a server.",
  vpnDisabled: "VPN is disabled on this server.",
  serverNotSpecified: "Server not specified.",
  profileNotSpecified: "Profile not specified.",
  unknownAction: "Unknown action.",
};

const locales: Record<UiLang, VpnLocale> = { en, ru };

/** Get VPN locale strings for the given language. */
export function getVpnLocale(lang: UiLang): VpnLocale {
  return locales[lang];
}
