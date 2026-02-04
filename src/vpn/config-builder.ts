import type { Peer, WgServer } from "./types.ts";

const ALLOWED_IPS = "0.0.0.0/0, ::/0";
const DNS = "1.1.1.1, 8.8.8.8";
const PERSISTENT_KEEPALIVE = 30;

/**
 * Generate a WireGuard configuration string from a peer and server.
 * Output matches the 2b Python peer_into_conf format exactly.
 */
export function peerToConfig(peer: Peer, server: WgServer, endpointHost: string): string {
  return `[Interface]
PrivateKey = ${peer.private_key}
Address = ${peer.address}
DNS = ${DNS}

[Peer]
PublicKey = ${server.public_key}
AllowedIPs = ${ALLOWED_IPS}
Endpoint = ${endpointHost}:${server.port}

PersistentKeepalive = ${PERSISTENT_KEEPALIVE}`;
}
