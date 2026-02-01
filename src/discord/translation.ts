/**
 * Bidirectional translation between Discord markup and human-readable text.
 * Inbound: Discord → human-readable (for LLM consumption).
 * Outbound: human-readable → Discord markup (for sending messages).
 */

export interface UserInfo {
  username: string;
  displayName: string;
}

export interface InboundResolvers {
  user: (id: string) => UserInfo | undefined;
  channel: (id: string) => string | undefined;
  role: (id: string) => string | undefined;
}

// Discord markup patterns
const USER_MENTION = /<@!?(\d+)>/g;
const CHANNEL_MENTION = /<#(\d+)>/g;
const ROLE_MENTION = /<@&(\d+)>/g;
const CUSTOM_EMOJI = /<a?:(\w+):\d+>/g;
const TIMESTAMP_WITH_STYLE = /<t:(\d+):([tTdDfFR])>/g;
const TIMESTAMP_NO_STYLE = /<t:(\d+)>/g;

/**
 * Translate Discord markup in a message to human-readable text.
 * Unknown IDs are preserved as-is to avoid data loss.
 */
export function translateInbound(
  content: string,
  resolvers: InboundResolvers
): string {
  if (!content) return content;

  let result = content;

  // User mentions: <@id> and <@!id>
  result = result.replace(USER_MENTION, (match, id) => {
    const info = resolvers.user(id);
    return info ? `@${info.username}` : match;
  });

  // Channel mentions: <#id>
  result = result.replace(CHANNEL_MENTION, (match, id) => {
    const name = resolvers.channel(id);
    return name ? `#${name}` : match;
  });

  // Role mentions: <@&id>
  result = result.replace(ROLE_MENTION, (match, id) => {
    const name = resolvers.role(id);
    return name ? `@${name}` : match;
  });

  // Custom and animated emoji: <:name:id> and <a:name:id>
  result = result.replace(CUSTOM_EMOJI, (_match, name) => `:${name}:`);

  // Timestamps with style: <t:unix:style>
  result = result.replace(TIMESTAMP_WITH_STYLE, (_match, unix, style) =>
    resolveDiscordTimestamp(Number(unix), style)
  );

  // Timestamps without style: <t:unix>
  result = result.replace(TIMESTAMP_NO_STYLE, (_match, unix) =>
    resolveDiscordTimestamp(Number(unix))
  );

  return result;
}

type TimestampStyle = "t" | "T" | "d" | "D" | "f" | "F" | "R";

/**
 * Resolve a Discord timestamp to human-readable text.
 * Styles follow Discord's format specifiers:
 *   t = short time, T = long time
 *   d = short date, D = long date
 *   f = short date+time (default), F = long date+time
 *   R = relative
 */
export function resolveDiscordTimestamp(
  unix: number,
  style: string = "f"
): string {
  const date = new Date(unix * 1000);

  switch (style as TimestampStyle) {
    case "t":
      return date.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      });
    case "T":
      return date.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      });
    case "d":
      return date.toLocaleDateString("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
      });
    case "D":
      return date.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      });
    case "f":
      return date.toLocaleString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    case "F":
      return date.toLocaleString("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    case "R": {
      const now = Date.now();
      const diffMs = date.getTime() - now;
      const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
      const absDiff = Math.abs(diffMs);
      if (absDiff < 60_000) return rtf.format(Math.round(diffMs / 1000), "second");
      if (absDiff < 3_600_000) return rtf.format(Math.round(diffMs / 60_000), "minute");
      if (absDiff < 86_400_000) return rtf.format(Math.round(diffMs / 3_600_000), "hour");
      if (absDiff < 2_592_000_000) return rtf.format(Math.round(diffMs / 86_400_000), "day");
      if (absDiff < 31_536_000_000) return rtf.format(Math.round(diffMs / 2_592_000_000), "month");
      return rtf.format(Math.round(diffMs / 31_536_000_000), "year");
    }
    default:
      return date.toLocaleString("en-US");
  }
}

// --- Outbound translation (human-readable → Discord markup) ---

export interface OutboundResolvers {
  /** Resolve a global username to a Discord user ID. */
  user: (username: string) => string | undefined;
  /** Resolve a channel name to a Discord channel ID. */
  channel: (name: string) => string | undefined;
  /** Resolve an emoji name to its ID and animated flag. */
  emoji: (name: string) => { id: string; animated: boolean } | undefined;
}

// Outbound patterns — match human-readable references in LLM output.
// @username: must be at start of string or preceded by whitespace (avoid emails).
const OUTBOUND_USER = /(?<=^|(?<=\s))@([\w.]+)/g;
// #channel: channel names can have hyphens and underscores.
const OUTBOUND_CHANNEL = /(?<=^|(?<=\s))#([\w-]+)/g;
// :emoji: standard colon-wrapped name (not already Discord markup).
const OUTBOUND_EMOJI = /(?<!<a?):(\w+):(?!\d+>)/g;

/**
 * Translate human-readable text from LLM output back to Discord markup.
 * Failed lookups are left as plain text; warnings collected in optional array.
 */
export function translateOutbound(
  content: string,
  resolvers: OutboundResolvers,
  warnings?: string[]
): string {
  if (!content) return content;

  let result = content;

  // User mentions: @username → <@id>
  result = result.replace(OUTBOUND_USER, (match, username) => {
    const id = resolvers.user(username);
    if (id) return `<@${id}>`;
    warnings?.push(`Failed to resolve user mention: @${username}`);
    return match;
  });

  // Channel mentions: #channel → <#id>
  result = result.replace(OUTBOUND_CHANNEL, (match, name) => {
    const id = resolvers.channel(name);
    if (id) return `<#${id}>`;
    warnings?.push(`Failed to resolve channel mention: #${name}`);
    return match;
  });

  // Custom emoji: :name: → <:name:id> or <a:name:id>
  result = result.replace(OUTBOUND_EMOJI, (match, name) => {
    const info = resolvers.emoji(name);
    if (info) return info.animated ? `<a:${name}:${info.id}>` : `<:${name}:${info.id}>`;
    warnings?.push(`Failed to resolve emoji: :${name}:`);
    return match;
  });

  return result;
}

/**
 * Build a display name context block for LLM consumption.
 * Maps @username to display names so the agent knows who is who.
 */
export function buildDisplayNameContext(
  users: Array<{ username: string; displayName: string }>
): string {
  if (users.length === 0) return "";
  return users
    .map((u) => `@${u.username} — ${u.displayName}`)
    .join("\n");
}
