import type { Peer, User, WgServer } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 10_000;

/** Error thrown when VPN API request times out. */
export class VpnTimeoutError extends Error {
  constructor(endpoint: string) {
    super(`VPN API request timed out: ${endpoint}`);
    this.name = "VpnTimeoutError";
  }
}

/** Error thrown when VPN API returns non-200 or JSON parse fails. */
export class VpnApiError extends Error {
  constructor(
    public readonly statusCode: number | null,
    public readonly endpoint: string,
    message: string,
  ) {
    super(message);
    this.name = "VpnApiError";
  }
}

export interface VpnClient {
  listServers(): Promise<WgServer[]>;
  getUser(userId: string): Promise<User | null>;
  createUser(userId: string, name: string): Promise<User>;
  deleteUser(userId: string): Promise<void>;
  listProfiles(userId: string): Promise<Peer[]>;
  createProfile(userId: string, serverName: string): Promise<Peer>;
  deleteProfile(serverName: string, address: string): Promise<void>;
}

/**
 * Create a VPN API client with injectable fetch for testing.
 */
export function createVpnClient(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): VpnClient {
  async function post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    const url = `${baseUrl}${endpoint}`;
    let response: Response;

    try {
      response = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new VpnTimeoutError(endpoint);
      }
      throw new VpnApiError(null, endpoint, `Network error: ${String(err)}`);
    }

    if (!response.ok) {
      throw new VpnApiError(response.status, endpoint, `HTTP ${response.status}`);
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw new VpnApiError(null, endpoint, "Invalid JSON response");
    }
  }

  return {
    async listServers(): Promise<WgServer[]> {
      return post<WgServer[]>("/list-servers", {});
    },

    async getUser(userId: string): Promise<User | null> {
      const result = await post<User | null>("/get-user", { user_id: userId });
      return result;
    },

    async createUser(userId: string, name: string): Promise<User> {
      return post<User>("/create-user", { user_id: userId, name });
    },

    async deleteUser(userId: string): Promise<void> {
      await post<unknown>("/delete-user", { user_id: userId });
    },

    async listProfiles(userId: string): Promise<Peer[]> {
      return post<Peer[]>("/list-profiles", { user_id: userId });
    },

    async createProfile(userId: string, serverName: string): Promise<Peer> {
      return post<Peer>("/create-profile", { user_id: userId, server_name: serverName });
    },

    async deleteProfile(serverName: string, address: string): Promise<void> {
      await post<unknown>("/delete-profile", { server_name: serverName, address });
    },
  };
}
