import { VpnApiError, VpnTimeoutError } from "./api-client.ts";
import type { VpnLocale } from "./i18n.ts";

/**
 * Map a VPN error to a user-friendly message using the provided locale.
 */
export function mapVpnError(error: unknown, locale: VpnLocale): string {
  if (error instanceof VpnTimeoutError) {
    return locale.timeout;
  }

  if (error instanceof VpnApiError) {
    if (error.statusCode !== null && error.statusCode >= 500) {
      return locale.serverError;
    }
    return locale.networkError;
  }

  return locale.unknown;
}
