import { VpnApiError, VpnTimeoutError } from "./api-client.ts";

/** Russian error messages for VPN UI. */
export const VPN_ERRORS = {
  TIMEOUT: "Сервер VPN не отвечает. Попробуйте позже.",
  SERVER_ERROR: "Ошибка сервера VPN. Попробуйте позже.",
  NETWORK_ERROR: "Не удалось связаться с сервером VPN.",
  UNKNOWN: "Произошла неизвестная ошибка.",
  PROFILE_LIMIT: "Достигнут лимит профилей (20). Удалите один из существующих.",
  USER_MISMATCH: "Эта панель принадлежит другому пользователю.",
  SESSION_EXPIRED: "Сессия истекла. Используйте /vpn снова.",
  NOT_IN_GUILD: "Команда /vpn доступна только на сервере.",
} as const;

/**
 * Map a VPN error to a user-friendly Russian message.
 */
export function mapVpnError(error: unknown): string {
  if (error instanceof VpnTimeoutError) {
    return VPN_ERRORS.TIMEOUT;
  }

  if (error instanceof VpnApiError) {
    if (error.statusCode !== null && error.statusCode >= 500) {
      return VPN_ERRORS.SERVER_ERROR;
    }
    return VPN_ERRORS.NETWORK_ERROR;
  }

  return VPN_ERRORS.UNKNOWN;
}
