import type { Logger } from "../logger.ts";
import type { VpnApiError, VpnTimeoutError } from "./api-client.ts";

/**
 * Log VPN command invocation.
 * Does not log any private keys or sensitive config data.
 */
export function logVpnCommand(
  logger: Logger,
  action: "invoke" | "create" | "delete" | "qr" | "download",
  userId: string,
  guildId: string,
  extra?: Record<string, unknown>,
): void {
  logger.info("vpn_command", {
    action,
    userId,
    guildId,
    ...extra,
  });
}

/**
 * Log VPN API error.
 * Includes endpoint and status code but no request body or keys.
 */
export function logVpnApiError(
  logger: Logger,
  error: VpnApiError | VpnTimeoutError,
  userId: string,
  guildId: string,
): void {
  const isTimeout = error.name === "VpnTimeoutError";
  const statusCode = "statusCode" in error ? error.statusCode : null;
  const endpoint = "endpoint" in error ? error.endpoint : "unknown";

  logger.error("vpn_api_error", {
    userId,
    guildId,
    endpoint,
    statusCode,
    isTimeout,
    errorMessage: error.message,
  });
}
