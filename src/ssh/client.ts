import { Client, type ConnectConfig, type ClientChannel } from "ssh2";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { generateKeyPairSync } from "crypto";

/** SSH key pair file paths */
export interface SshKeyPaths {
  privateKey: string;
  publicKey: string;
  authorizedKeys: string;
  knownHosts: string;
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
 * Get paths for SSH key files within the ssh-keys volume.
 */
export function getSshKeyPaths(sshKeysDir: string): SshKeyPaths {
  return {
    privateKey: join(sshKeysDir, "id_ed25519"),
    publicKey: join(sshKeysDir, "id_ed25519.pub"),
    authorizedKeys: join(sshKeysDir, "authorized_keys"),
    knownHosts: join(sshKeysDir, "known_hosts"),
  };
}

/**
 * Ensure SSH keypair exists. Generates new ED25519 keypair if missing.
 * Also writes the public key to authorized_keys for the bash-vm container.
 */
export function ensureSshKeys(paths: SshKeyPaths): void {
  // Create directory if needed
  const dir = join(paths.privateKey, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
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

  // Write keys
  writeFileSync(paths.privateKey, privateKey, { mode: 0o600 });
  writeFileSync(paths.publicKey, opensshPubKey + "\n", { mode: 0o644 });
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
  return new Promise((resolve) => {
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
      client.exec("pkill -TERM -P $$ 2>/dev/null; sleep 2; pkill -KILL -P $$ 2>/dev/null", () => {
        // Ignore result
      });
      // Resolve after allowing some time for cleanup
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve({ stdout, exitCode, timedOut: true });
        }
      }, 2500);
    }, options.timeoutMs);

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
  });
}

/**
 * Shell-escape a string for safe inclusion in a command.
 */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
