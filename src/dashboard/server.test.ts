import { describe, expect, test } from "bun:test";
import {
  isIpv4InCidr,
  isPasswordlessDashboardRequest,
  parseDashboardPasswordlessCidrs,
  requestClientIpCandidates,
} from "./server.ts";

describe("dashboard passwordless network auth", () => {
  test("parses CIDRs from comma or whitespace separated env values", () => {
    expect(parseDashboardPasswordlessCidrs("10.16.0.0/16, 192.168.1.4/32\n172.16.0.0/12"))
      .toEqual(["10.16.0.0/16", "192.168.1.4/32", "172.16.0.0/12"]);
    expect(parseDashboardPasswordlessCidrs(undefined)).toEqual([]);
    expect(parseDashboardPasswordlessCidrs("  ")).toEqual([]);
  });

  test("matches IPv4 CIDR ranges", () => {
    expect(isIpv4InCidr("10.16.4.2", "10.16.0.0/16")).toBe(true);
    expect(isIpv4InCidr("10.17.4.2", "10.16.0.0/16")).toBe(false);
    expect(isIpv4InCidr("::ffff:10.16.4.2", "10.16.0.0/16")).toBe(true);
    expect(isIpv4InCidr("10.16.4.2:1234", "10.16.0.0/16")).toBe(true);
    expect(isIpv4InCidr("not-an-ip", "10.16.0.0/16")).toBe(false);
  });

  test("uses forwarded client IP only from trusted proxies", () => {
    const req = new Request("http://dashboard.local", {
      headers: {
        "x-forwarded-for": "203.0.113.9, 10.16.4.2",
        "x-real-ip": "10.16.9.9",
      },
    });

    expect(requestClientIpCandidates(req, "127.0.0.1", ["127.0.0.1/32"])).toEqual([
      "10.16.4.2",
      "127.0.0.1",
    ]);
    expect(requestClientIpCandidates(req, "203.0.113.20", ["127.0.0.1/32"])).toEqual([
      "203.0.113.20",
    ]);
  });

  test("allows passwordless access only for configured CIDRs", () => {
    const allowed = new Request("http://dashboard.local", {
      headers: { "x-forwarded-for": "10.16.4.2" },
    });
    const denied = new Request("http://dashboard.local", {
      headers: { "x-forwarded-for": "10.17.4.2" },
    });

    expect(isPasswordlessDashboardRequest(allowed, ["10.16.0.0/16"], "127.0.0.1", ["127.0.0.1/32"])).toBe(true);
    expect(isPasswordlessDashboardRequest(denied, ["10.16.0.0/16"], "127.0.0.1", ["127.0.0.1/32"])).toBe(false);
    expect(isPasswordlessDashboardRequest(allowed, [])).toBe(false);
  });

  test("does not accept spoofed forwarded headers from untrusted clients", () => {
    const spoofed = new Request("http://dashboard.local", {
      headers: { "x-forwarded-for": "10.16.4.2" },
    });
    const proxied = new Request("http://dashboard.local", {
      headers: { "x-forwarded-for": "198.51.100.8, 10.16.4.2" },
    });

    expect(isPasswordlessDashboardRequest(spoofed, ["10.16.0.0/16"], "203.0.113.20", ["127.0.0.1/32"]))
      .toBe(false);
    expect(isPasswordlessDashboardRequest(proxied, ["10.16.0.0/16"], "127.0.0.1", ["127.0.0.1/32"]))
      .toBe(true);
  });
});
