/**
 * VPN data contracts matching the configured VPN API.
 * These types mirror the upstream Python TypedDict definitions.
 */

/** WireGuard server configuration as returned by /list-servers. */
export interface WgServer {
  /** Internal interface name (e.g., "eu1"). */
  interface: string;
  /** Human-readable server name shown in UI. */
  public_name: string;
  /** Server's WireGuard public key. */
  public_key: string;
  /** IP address counter for allocation. */
  counter: number;
  /** List of peers on this server. */
  peers: Peer[];
  /** WireGuard listen port. */
  port: number;
  /** IP prefix for address allocation (e.g., "10.0"). */
  prefix: string;
}

/** WireGuard peer (profile) as returned by /create-profile or /list-profiles. */
export interface Peer {
  /** Peer's WireGuard public key. */
  public_key: string;
  /** Peer's WireGuard private key (client-side). */
  private_key: string;
  /** Assigned IP address (CIDR notation, e.g., "10.0.0.1/32"). */
  address: string;
  /** Server public_name this peer belongs to. */
  server_name: string;
  /** Human-readable profile name. */
  name: string;
}

/** VPN user as returned by /get-user or /create-user. */
export interface User {
  /** Discord user ID. */
  id: string;
  /** Optional display name. */
  name: string | null;
  /** User's profiles across all servers. */
  peers: Peer[];
}
