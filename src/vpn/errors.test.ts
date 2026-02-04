import { describe, test, expect } from "bun:test";
import { mapVpnError } from "./errors.ts";
import { VpnApiError, VpnTimeoutError } from "./api-client.ts";
import { getVpnLocale } from "./i18n.ts";

const ruLocale = getVpnLocale("ru");
const enLocale = getVpnLocale("en");

describe("mapVpnError", () => {
  test("maps VpnTimeoutError to timeout message (ru)", () => {
    const error = new VpnTimeoutError("/list-servers");
    expect(mapVpnError(error, ruLocale)).toBe(ruLocale.timeout);
  });

  test("maps VpnTimeoutError to timeout message (en)", () => {
    const error = new VpnTimeoutError("/list-servers");
    expect(mapVpnError(error, enLocale)).toBe(enLocale.timeout);
  });

  test("maps VpnApiError with 5xx to server error message", () => {
    const error = new VpnApiError(503, "/list-servers", "Service Unavailable");
    expect(mapVpnError(error, ruLocale)).toBe(ruLocale.serverError);
  });

  test("maps VpnApiError with null status to network error message", () => {
    const error = new VpnApiError(null, "/list-servers", "Network error");
    expect(mapVpnError(error, ruLocale)).toBe(ruLocale.networkError);
  });

  test("maps unknown errors to unknown message", () => {
    expect(mapVpnError(new Error("random"), ruLocale)).toBe(ruLocale.unknown);
    expect(mapVpnError("string error", enLocale)).toBe(enLocale.unknown);
    expect(mapVpnError(null, ruLocale)).toBe(ruLocale.unknown);
  });
});
