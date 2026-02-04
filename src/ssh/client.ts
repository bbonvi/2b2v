import { Client, type ConnectConfig, type ClientChannel } from "ssh2";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { generateKeyPairSync, createPrivateKey, randomBytes } from "crypto";

/** SSH key pair file paths - split between local (bot-only) and shared (for bash-vm) */
export interface SshKeyPaths {
  // Local to bot container - never shared
  privateKey: string;
  publicKey: string;
  knownHosts: string;
  // Shared with bash-vm - only the public key for authentication
  authorizedKeys: string;
}

/** SSH connection configuration */
export interface SshConfig {
  host: string;
  port: number;
  username: string;
}

/** Result of SSH command execution */
export interface SshExecResult {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Get paths for SSH key files.
 * @param localDir - Bot-local directory for private key (not shared with bash-vm)
 * @param sharedDir - Shared directory for authorized_keys (mounted by bash-vm)
 */
export function getSshKeyPaths(localDir: string, sharedDir: string): SshKeyPaths {
  return {
    privateKey: join(localDir, "id_ed25519"),
    publicKey: join(localDir, "id_ed25519.pub"),
    knownHosts: join(localDir, "known_hosts"),
    authorizedKeys: join(sharedDir, "authorized_keys"),
  };
}

/**
 * Ensure SSH keypair exists. Generates new ED25519 keypair if missing.
 * Private key stays local to bot. Only authorized_keys is written to shared dir.
 */
export function ensureSshKeys(paths: SshKeyPaths): void {
  // Create local directory for private key (bot-only)
  const localDir = join(paths.privateKey, "..");
  if (!existsSync(localDir)) {
    mkdirSync(localDir, { recursive: true });
  }

  // Create shared directory for authorized_keys (mounted by bash-vm)
  const sharedDir = join(paths.authorizedKeys, "..");
  if (!existsSync(sharedDir)) {
    mkdirSync(sharedDir, { recursive: true });
  }

  // Check if keys already exist
  if (existsSync(paths.privateKey) && existsSync(paths.publicKey)) {
    // Ensure authorized_keys is in sync
    const pubKey = readFileSync(paths.publicKey, "utf-8").trim();
    const currentAuth = existsSync(paths.authorizedKeys)
      ? readFileSync(paths.authorizedKeys, "utf-8").trim()
      : "";
    if (currentAuth !== pubKey) {
      writeFileSync(paths.authorizedKeys, pubKey + "\n", { mode: 0o644 });
    }
    return;
  }

  // Generate new ED25519 keypair
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  // Convert PEM to OpenSSH format for public key
  const opensshPubKey = pemToOpenSshPublicKey(publicKey);

  // Convert private key to OpenSSH format (ssh2 doesn't support PKCS8 for ED25519)
  const opensshPrivateKey = pkcs8ToOpenSshPrivateKey(privateKey, publicKey);

  // Write private key to LOCAL directory only (never shared)
  writeFileSync(paths.privateKey, opensshPrivateKey, { mode: 0o600 });
  writeFileSync(paths.publicKey, opensshPubKey + "\n", { mode: 0o644 });

  // Write ONLY public key to shared directory for bash-vm authentication
  writeFileSync(paths.authorizedKeys, opensshPubKey + "\n", { mode: 0o644 });
}

/**
 * Convert PEM-encoded public key to OpenSSH format.
 * ED25519 keys have a specific structure we need to handle.
 */
function pemToOpenSshPublicKey(pemPublicKey: string): string {
  // Extract the base64 content from PEM
  const lines = pemPublicKey.split("\n").filter((l) => !l.startsWith("-----") && l.trim() !== "");
  const der = Buffer.from(lines.join(""), "base64");

  // ED25519 SPKI format: fixed prefix (12 bytes) + 32-byte key
  // The prefix is: 30 2a 30 05 06 03 2b 65 70 03 21 00
  const keyData = der.subarray(12);

  // OpenSSH format: "ssh-ed25519" + key_type_length + key_type + key_length + key
  const keyType = Buffer.from("ssh-ed25519");
  const keyTypeLen = Buffer.alloc(4);
  keyTypeLen.writeUInt32BE(keyType.length, 0);
  const keyLen = Buffer.alloc(4);
  keyLen.writeUInt32BE(keyData.length, 0);

  const opensshKey = Buffer.concat([keyTypeLen, keyType, keyLen, keyData]);
  return `ssh-ed25519 ${opensshKey.toString("base64")} bash-tool`;
}

/**
 * Convert PKCS8 PEM private key to OpenSSH format.
 * ssh2 library doesn't support PKCS8 for ED25519, requires OpenSSH format.
 */
function pkcs8ToOpenSshPrivateKey(pkcs8Pem: string, spkiPem: string): string {
  // Extract 32-byte seed from PKCS8 PEM
  // PKCS8 DER structure (48 bytes total):
  //   30 2e           - SEQUENCE (46 bytes)
  //   02 01 00        - INTEGER 0 (version)
  //   30 05 06 03 2b 65 70 - AlgorithmIdentifier (ed25519 OID)
  //   04 22           - OCTET STRING (34 bytes)
  //   04 20           - OCTET STRING (32 bytes) - inner wrapper
  //   <32 bytes>      - the actual seed
  // Seed starts at offset 16
  const keyObj = createPrivateKey(pkcs8Pem);
  const pkcs8Der = keyObj.export({ type: "pkcs8", format: "der" });
  const seed = pkcs8Der.subarray(16, 16 + 32);

  // Extract 32-byte public key from SPKI PEM
  const pubLines = spkiPem.split("\n").filter((l) => !l.startsWith("-----") && l.trim() !== "");
  const pubDer = Buffer.from(pubLines.join(""), "base64");
  const pubKey = pubDer.subarray(12); // 12-byte SPKI header for ED25519

  // Build OpenSSH public key blob
  const keyType = Buffer.from("ssh-ed25519");
  const pubKeyBlob = Buffer.concat([
    writeString(keyType),
    writeString(pubKey),
  ]);

  // Build private section (unencrypted)
  const checkInt = randomBytes(4);
  const privateSection = Buffer.concat([
    checkInt,
    checkInt, // repeated for verification
    writeString(keyType),
    writeString(pubKey),
    writeString(Buffer.concat([seed, pubKey])), // ED25519 private = seed (32) + public (32)
    writeString(Buffer.from("bash-tool")), // comment
  ]);

  // Add padding (1, 2, 3, ... to reach 8-byte alignment)
  const blockSize = 8;
  const padLen = blockSize - (privateSection.length % blockSize);
  const padding = Buffer.alloc(padLen);
  for (let i = 0; i < padLen; i++) {
    padding[i] = i + 1;
  }
  const paddedPrivate = Buffer.concat([privateSection, padding]);

  // Build full OpenSSH key
  const AUTH_MAGIC = Buffer.from("openssh-key-v1\0");
  const opensshKey = Buffer.concat([
    AUTH_MAGIC,
    writeString(Buffer.from("none")), // cipher
    writeString(Buffer.from("none")), // kdf
    writeString(Buffer.alloc(0)), // kdf options (empty)
    writeUint32(1), // number of keys
    writeString(pubKeyBlob), // public key blob
    writeString(paddedPrivate), // private section
  ]);

  // Wrap in PEM
  const b64 = opensshKey.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 70) {
    lines.push(b64.slice(i, i + 70));
  }
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** Write a string in OpenSSH format: 4-byte length (BE) + data */
function writeString(data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return Buffer.concat([len, data]);
}

/** Write a uint32 in big-endian format */
function writeUint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

/**
 * Remove a host entry from known_hosts file.
 */
export function removeKnownHost(knownHostsPath: string, host: string, port: number): void {
  if (!existsSync(knownHostsPath)) return;

  const content = readFileSync(knownHostsPath, "utf-8");
  const lines = content.split("\n");

  // Host key entries can be formatted as "[host]:port" or just "host"
  const hostPatterns = port === 22 ? [host, `[${host}]:${port}`] : [`[${host}]:${port}`];

  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return true;
    const firstSpace = trimmed.indexOf(" ");
    if (firstSpace === -1) return true;
    const hostPart = trimmed.substring(0, firstSpace);
    return !hostPatterns.some((p) => hostPart === p || hostPart.startsWith(p + ","));
  });

  writeFileSync(knownHostsPath, filtered.join("\n"), { mode: 0o644 });
}

/**
 * Create an SSH client with automatic host-key mismatch recovery.
 * On connection failure due to host key mismatch, removes the stale entry and retries once.
 */
export async function createSshConnection(
  config: SshConfig,
  paths: SshKeyPaths,
  retryOnHostKeyMismatch = true
): Promise<Client> {
  const privateKey = readFileSync(paths.privateKey, "utf-8");

  const connectConfig: ConnectConfig = {
    host: config.host,
    port: config.port,
    username: config.username,
    privateKey,
    readyTimeout: 10000,
    hostVerifier: (hostKey: Buffer) => {
      // Verify or record host key
      const hostKeyBase64 = hostKey.toString("base64");
      const hostEntry =
        config.port === 22
          ? `${config.host} ssh-ed25519 ${hostKeyBase64}`
          : `[${config.host}]:${config.port} ssh-ed25519 ${hostKeyBase64}`;

      if (!existsSync(paths.knownHosts)) {
        writeFileSync(paths.knownHosts, hostEntry + "\n", { mode: 0o644 });
        return true;
      }

      const known = readFileSync(paths.knownHosts, "utf-8");
      const lines = known.split("\n").map((l) => l.trim());

      // Check if this host is already known
      const hostPatterns =
        config.port === 22
          ? [config.host, `[${config.host}]:${config.port}`]
          : [`[${config.host}]:${config.port}`];

      for (const line of lines) {
        if (line === "" || line.startsWith("#")) continue;
        const parts = line.split(" ");
        if (parts.length < 3) continue;

        const knownHost = parts[0] ?? "";
        const knownKeyType = parts[1] ?? "";
        const knownKeyData = parts[2] ?? "";

        if (hostPatterns.some((p) => knownHost === p || knownHost.startsWith(p + ","))) {
          // Host found - check if key matches
          if (knownKeyData === hostKeyBase64 && knownKeyType === "ssh-ed25519") {
            return true;
          }
          // Key mismatch - will trigger retry if enabled
          return false;
        }
      }

      // Host not found - add it
      writeFileSync(paths.knownHosts, known.trimEnd() + "\n" + hostEntry + "\n", { mode: 0o644 });
      return true;
    },
  };

  return new Promise((resolve, reject) => {
    const client = new Client();

    client.on("ready", () => {
      resolve(client);
    });

    client.on("error", (err) => {
      client.end();
      if (
        retryOnHostKeyMismatch &&
        (err.message.includes("Host key verification failed") ||
          err.message.includes("Handshake failed") ||
          (err as unknown as { level?: string }).level === "client-authentication")
      ) {
        // Remove stale host entry and retry once
        removeKnownHost(paths.knownHosts, config.host, config.port);
        createSshConnection(config, paths, false)
          .then(resolve)
          .catch(reject);
      } else {
        reject(err);
      }
    });

    client.connect(connectConfig);
  });
}

/**
 * Execute a command over SSH with timeout handling.
 * Returns stdout, exit code, and timeout status.
 */
export async function execSshCommand(
  client: Client,
  command: string,
  options: {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs: number;
    pty?: boolean;
  }
): Promise<SshExecResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let exitCode: number | null = null;
    let timedOut = false;
    let resolved = false;

    // Build command with optional cwd and env
    let fullCommand = command;
    if (options.cwd !== undefined) {
      fullCommand = `cd ${shellEscape(options.cwd)} && ${command}`;
    }
    if (options.env !== undefined && Object.keys(options.env).length > 0) {
      const envPrefix = Object.entries(options.env)
        .map(([k, v]) => `${k}=${shellEscape(v)}`)
        .join(" ");
      fullCommand = `${envPrefix} ${fullCommand}`;
    }

    const execOptions = options.pty === true ? { pty: true } : {};

    // Set up timeout
    const timeoutHandle = setTimeout(() => {
      if (resolved) return;
      timedOut = true;
      // Try to kill the process - send SIGTERM first
      try {
        client.exec("pkill -TERM -P $$ 2>/dev/null; sleep 2; pkill -KILL -P $$ 2>/dev/null", () => {
          // Ignore result
        });
      } catch {
        // Client may be disconnected, ignore
      }
      // Resolve after allowing some time for cleanup
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({ stdout, exitCode, timedOut: true });
        }
      }, 2500);
    }, options.timeoutMs);

    try {
      client.exec(fullCommand, execOptions, (err, stream) => {
        if (err !== undefined) {
          clearTimeout(timeoutHandle);
          if (!resolved) {
            resolved = true;
            resolve({ stdout: err.message, exitCode: 1, timedOut: false });
          }
          return;
        }

        const handleStream = (s: ClientChannel) => {
          if (options.stdin !== undefined) {
            s.write(options.stdin);
            s.end();
          }

          s.on("data", (data: Buffer) => {
            stdout += data.toString();
          });

          // Capture stderr to stdout for simplicity (user can redirect in command)
          s.stderr.on("data", (_data: Buffer) => {
            // stderr is discarded per spec unless redirected in command
          });

          s.on("close", (code: number | null) => {
            clearTimeout(timeoutHandle);
            if (!resolved) {
              resolved = true;
              exitCode = code;
              resolve({ stdout, exitCode, timedOut });
            }
          });
        };

        handleStream(stream);
      });
    } catch (err) {
      clearTimeout(timeoutHandle);
      resolved = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/**
 * Shell-escape a string for safe inclusion in a command.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
