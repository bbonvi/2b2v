import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getSshKeyPaths, ensureSshKeys, removeKnownHost } from "./client.ts";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ssh-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("getSshKeyPaths returns expected paths", () => {
  const paths = getSshKeyPaths("/ssh-keys");
  expect(paths.privateKey).toBe("/ssh-keys/id_ed25519");
  expect(paths.publicKey).toBe("/ssh-keys/id_ed25519.pub");
  expect(paths.authorizedKeys).toBe("/ssh-keys/authorized_keys");
  expect(paths.knownHosts).toBe("/ssh-keys/known_hosts");
});

test("ensureSshKeys generates keypair on first run", () => {
  const paths = getSshKeyPaths(tempDir);
  ensureSshKeys(paths);

  expect(existsSync(paths.privateKey)).toBe(true);
  expect(existsSync(paths.publicKey)).toBe(true);
  expect(existsSync(paths.authorizedKeys)).toBe(true);

  // Private key should be PEM format
  const privateKey = readFileSync(paths.privateKey, "utf-8");
  expect(privateKey).toStartWith("-----BEGIN PRIVATE KEY-----");

  // Public key should be OpenSSH format
  const publicKey = readFileSync(paths.publicKey, "utf-8");
  expect(publicKey).toStartWith("ssh-ed25519 ");

  // authorized_keys should match public key
  const authorizedKeys = readFileSync(paths.authorizedKeys, "utf-8");
  expect(authorizedKeys.trim()).toBe(publicKey.trim());
});

test("ensureSshKeys reuses existing keypair", () => {
  const paths = getSshKeyPaths(tempDir);
  ensureSshKeys(paths);

  const originalPrivate = readFileSync(paths.privateKey, "utf-8");
  const originalPublic = readFileSync(paths.publicKey, "utf-8");

  // Call again
  ensureSshKeys(paths);

  const newPrivate = readFileSync(paths.privateKey, "utf-8");
  const newPublic = readFileSync(paths.publicKey, "utf-8");

  expect(newPrivate).toBe(originalPrivate);
  expect(newPublic).toBe(originalPublic);
});

test("ensureSshKeys syncs authorized_keys if out of sync", () => {
  const paths = getSshKeyPaths(tempDir);
  ensureSshKeys(paths);

  const publicKey = readFileSync(paths.publicKey, "utf-8").trim();

  // Corrupt authorized_keys
  writeFileSync(paths.authorizedKeys, "corrupted\n");

  // Call again
  ensureSshKeys(paths);

  const authorizedKeys = readFileSync(paths.authorizedKeys, "utf-8").trim();
  expect(authorizedKeys).toBe(publicKey);
});

test("removeKnownHost removes matching host entry", () => {
  const paths = getSshKeyPaths(tempDir);
  const knownHostsContent = `
[bash-vm]:22 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey==
other-host ssh-rsa AAAAB3Nz...
`;
  writeFileSync(paths.knownHosts, knownHostsContent);

  removeKnownHost(paths.knownHosts, "bash-vm", 22);

  const result = readFileSync(paths.knownHosts, "utf-8");
  expect(result).not.toContain("[bash-vm]:22");
  expect(result).toContain("other-host");
});

test("removeKnownHost handles non-existent file", () => {
  const paths = getSshKeyPaths(tempDir);
  // Should not throw
  removeKnownHost(paths.knownHosts, "bash-vm", 22);
  expect(existsSync(paths.knownHosts)).toBe(false);
});

test("removeKnownHost handles standard port format", () => {
  const paths = getSshKeyPaths(tempDir);
  const knownHostsContent = `example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKey==
`;
  writeFileSync(paths.knownHosts, knownHostsContent);

  removeKnownHost(paths.knownHosts, "example.com", 22);

  const result = readFileSync(paths.knownHosts, "utf-8");
  expect(result.trim()).toBe("");
});
