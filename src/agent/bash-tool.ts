import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Client } from "ssh2";
import type { BashToolConfig } from "../config/types.ts";
import { execSshCommand, type SshExecResult } from "../ssh/client.ts";

const BashParams = Type.Object({
  command: Type.String({ description: "The shell command to execute." }),
  cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to home directory." })),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Environment variables to set for the command.",
    })
  ),
  stdin: Type.Optional(Type.String({ description: "Input to pipe to the command's stdin." })),
  timeoutMs: Type.Optional(
    Type.Number({
      description: "Timeout in milliseconds. Capped at 5000.",
      minimum: 1,
      maximum: 5000,
    })
  ),
  pty: Type.Optional(
    Type.Boolean({
      description: "Allocate a pseudo-terminal. Useful for commands that require TTY.",
      default: false,
    })
  ),
});

/** Result details returned from bash tool execution. */
export interface BashToolDetails {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  blockedPattern?: string;
}

/** Dependencies for the bash tool. */
export interface BashToolDeps {
  /** SSH client connection to bash-vm. */
  getClient: () => Promise<Client>;
  /** Resolved bash tool config. */
  config: BashToolConfig;
}

/** IPv4 pattern for redaction. Requires exactly 4 octets, not preceded or followed by more. */
const IPV4_PATTERN = /(?<!\d\.)(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\.\d)(?!\d)/g;

/** IPv6 pattern for redaction. Matches standard formats including compressed. */
const IPV6_PATTERN =
  /(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}|:(?::[0-9a-fA-F]{1,4}){1,7}|::)/g;

/**
 * Redact IP addresses from output.
 */
export function redactIpAddresses(text: string): string {
  return text.replace(IPV4_PATTERN, "[IP]").replace(IPV6_PATTERN, "[IP]");
}

/**
 * Check command against blocklist patterns.
 * Returns the first matching pattern or null if no match.
 */
export function checkBlocklist(command: string, blocklist: string[]): string | null {
  for (const pattern of blocklist) {
    const regex = new RegExp(pattern, "i");
    if (regex.test(command)) {
      return pattern;
    }
  }
  return null;
}

/**
 * Create the bash AgentTool with injected dependencies.
 */
export function createBashTool(deps: BashToolDeps): AgentTool {
  const { getClient, config } = deps;
  const maxTimeout = Math.min(config.timeoutMs, 5000);

  return {
    name: "bash",
    label: "Bash",
    description:
      "Execute a shell command in an isolated Linux environment. " +
      "Commands run in a fresh session (no state persists). " +
      "Output is truncated at ~4000 chars. IPs are redacted. " +
      "Timeout is 5 seconds max. Redirect stderr with 2>&1 if needed.",
    parameters: BashParams,

    async execute(
      _toolCallId: string,
      params: unknown
    ): Promise<AgentToolResult<BashToolDetails>> {
      const { command, cwd, env, stdin, timeoutMs, pty } = params as {
        command: string;
        cwd?: string;
        env?: Record<string, string>;
        stdin?: string;
        timeoutMs?: number;
        pty?: boolean;
      };

      // Check blocklist BEFORE any execution
      const blockedPattern = checkBlocklist(command, config.blocklist);
      if (blockedPattern !== null) {
        return {
          content: [
            {
              type: "text",
              text: `Command blocked: matches pattern "${blockedPattern}". This restriction cannot be bypassed.`,
            },
          ],
          details: {
            ok: false,
            exitCode: null,
            timedOut: false,
            truncated: false,
            blockedPattern,
          },
        };
      }

      // Get SSH client
      let client: Client;
      try {
        client = await getClient();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `SSH connection failed: ${errMsg}` }],
          details: { ok: false, exitCode: null, timedOut: false, truncated: false },
        };
      }

      // Execute command
      const effectiveTimeout = Math.min(timeoutMs ?? maxTimeout, maxTimeout);
      let result: SshExecResult;
      try {
        result = await execSshCommand(client, command, {
          cwd,
          env,
          stdin,
          timeoutMs: effectiveTimeout,
          pty,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Command execution failed: ${errMsg}` }],
          details: { ok: false, exitCode: null, timedOut: false, truncated: false },
        };
      }

      // Redact IPs
      let output = redactIpAddresses(result.stdout);

      // Truncate
      let truncated = false;
      if (output.length > config.outputLimit) {
        output = output.slice(0, config.outputLimit) + "\n[output truncated]";
        truncated = true;
      }

      const ok = result.exitCode === 0 && !result.timedOut;

      // Format response
      let responseText = output;
      if (result.timedOut) {
        responseText = `[Command timed out after ${effectiveTimeout}ms]\n${output}`;
      } else if (result.exitCode !== null && result.exitCode !== 0) {
        responseText = `[Exit code: ${result.exitCode}]\n${output}`;
      }

      return {
        content: [{ type: "text", text: responseText }],
        details: {
          ok,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated,
        },
      };
    },
  };
}
