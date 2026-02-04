import { describe, test, expect } from "bun:test";
import { peerToConfig } from "./config-builder.ts";
import type { Peer, WgServer } from "./types.ts";

describe("peerToConfig", () => {
  const peer: Peer = {
    public_key: "peerPubKey123",
    private_key: "peerPrivKey456",
    address: "10.0.0.1/32",
    server_name: "eu1",
    name: "big-coconut",
  };

  const server: WgServer = {
    interface: "wg0",
    public_name: "eu1",
    public_key: "serverPubKey789",
    counter: 1,
    peers: [],
    port: 51820,
    prefix: "10.0",
  };

  test("generates correct WireGuard config format", () => {
    const config = peerToConfig(peer, server, "195.2.71.75");

    expect(config).toBe(`[Interface]
PrivateKey = peerPrivKey456
Address = 10.0.0.1/32
DNS = 1.1.1.1, 8.8.8.8

[Peer]
PublicKey = serverPubKey789
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 195.2.71.75:51820

PersistentKeepalive = 30`);
  });

  test("uses custom endpoint host", () => {
    const config = peerToConfig(peer, server, "vpn.example.com");
    expect(config).toContain("Endpoint = vpn.example.com:51820");
  });

  test("uses server port in endpoint", () => {
    const serverWithDifferentPort = { ...server, port: 443 };
    const config = peerToConfig(peer, serverWithDifferentPort, "195.2.71.75");
    expect(config).toContain("Endpoint = 195.2.71.75:443");
  });
});
