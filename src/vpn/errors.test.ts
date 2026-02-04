import { describe, test, expect } from "bun:test";
import { mapVpnError, VPN_ERRORS } from "./errors.ts";
import { VpnApiError, VpnTimeoutError } from "./api-client.ts";

describe("mapVpnError", () => {
  test("maps VpnTimeoutError to timeout message", () => {
    const error = new VpnTimeoutError("/list-servers");
    expect(mapVpnError(error)).toBe(VPN_ERRORS.TIMEOUT);
  });

  test("maps VpnApiError with 5xx to server error message", () => {
    const error = new VpnApiError(503, "/list-servers", "Service Unavailable");
    expect(mapVpnError(error)).toBe(VPN_ERRORS.SERVER_ERROR);
  });

  test("maps VpnApiError with null status to network error message", () => {
    const error = new VpnApiError(null, "/list-servers", "Network error");
    expect(mapVpnError(error)).toBe(VPN_ERRORS.NETWORK_ERROR);
  });

  test("maps unknown errors to unknown message", () => {
    expect(mapVpnError(new Error("random"))).toBe(VPN_ERRORS.UNKNOWN);
    expect(mapVpnError("string error")).toBe(VPN_ERRORS.UNKNOWN);
    expect(mapVpnError(null)).toBe(VPN_ERRORS.UNKNOWN);
  });
});
