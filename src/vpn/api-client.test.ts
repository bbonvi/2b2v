import { describe, test, expect, mock } from "bun:test";
import {
  createVpnClient,
  VpnApiError,
  VpnTimeoutError,
} from "./api-client.ts";

function mockFetch(response: Response | Error): typeof fetch {
  return mock(() => {
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  }) as unknown as typeof fetch;
}

describe("VpnClient", () => {
  const baseUrl = "https://vpn.example.com";

  describe("listServers", () => {
    test("returns servers on success", async () => {
      const servers = [
        { interface: "wg0", public_name: "eu1", public_key: "key1", counter: 1, peers: [], port: 51820, prefix: "10.0" },
      ];
      const client = createVpnClient(baseUrl, mockFetch(new Response(JSON.stringify(servers))));

      const result = await client.listServers();
      expect(result).toEqual(servers);
    });

    test("throws VpnApiError on non-200 response", async () => {
      const client = createVpnClient(baseUrl, mockFetch(new Response("error", { status: 500 })));

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test expect().rejects is thenable
      await expect(client.listServers()).rejects.toBeInstanceOf(VpnApiError);
    });
  });

  describe("getUser", () => {
    test("returns user on success", async () => {
      const user = { id: "123", name: "test", peers: [] };
      const client = createVpnClient(baseUrl, mockFetch(new Response(JSON.stringify(user))));

      const result = await client.getUser("123");
      expect(result).toEqual(user);
    });

    test("returns null when user not found", async () => {
      const client = createVpnClient(baseUrl, mockFetch(new Response("null")));

      const result = await client.getUser("123");
      expect(result).toBeNull();
    });
  });

  describe("createUser", () => {
    test("returns created user", async () => {
      const user = { id: "123", name: "test", peers: [] };
      const client = createVpnClient(baseUrl, mockFetch(new Response(JSON.stringify(user))));

      const result = await client.createUser("123", "test");
      expect(result).toEqual(user);
    });
  });

  describe("listProfiles", () => {
    test("returns profiles on success", async () => {
      const profiles = [{ public_key: "pk", private_key: "sk", address: "10.0.0.1/32", server_name: "eu1", name: "test" }];
      const client = createVpnClient(baseUrl, mockFetch(new Response(JSON.stringify(profiles))));

      const result = await client.listProfiles("123");
      expect(result).toEqual(profiles);
    });
  });

  describe("createProfile", () => {
    test("returns created profile", async () => {
      const profile = { public_key: "pk", private_key: "sk", address: "10.0.0.1/32", server_name: "eu1", name: "test" };
      const client = createVpnClient(baseUrl, mockFetch(new Response(JSON.stringify(profile))));

      const result = await client.createProfile("123", "eu1");
      expect(result).toEqual(profile);
    });
  });

  describe("deleteProfile", () => {
    test("resolves on success", async () => {
      const client = createVpnClient(baseUrl, mockFetch(new Response("{}")));

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test expect().resolves is thenable
      await expect(client.deleteProfile("eu1", "10.0.0.1/32")).resolves.toBeUndefined();
    });
  });

  describe("timeout handling", () => {
    test("throws VpnTimeoutError on AbortError", async () => {
      const abortError = new DOMException("signal timed out", "AbortError");
      const client = createVpnClient(baseUrl, mockFetch(abortError));

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test expect().rejects is thenable
      await expect(client.listServers()).rejects.toBeInstanceOf(VpnTimeoutError);
    });
  });

  describe("error handling", () => {
    test("throws VpnApiError with status code on HTTP error", async () => {
      const client = createVpnClient(baseUrl, mockFetch(new Response("error", { status: 503 })));

      try {
        await client.listServers();
        expect.unreachable("Should throw");
      } catch (e) {
        expect(e).toBeInstanceOf(VpnApiError);
        expect((e as VpnApiError).statusCode).toBe(503);
      }
    });

    test("wraps JSON parse errors", async () => {
      const client = createVpnClient(baseUrl, mockFetch(new Response("not json")));

      // eslint-disable-next-line @typescript-eslint/await-thenable -- bun:test expect().rejects is thenable
      await expect(client.listServers()).rejects.toBeInstanceOf(VpnApiError);
    });
  });
});
