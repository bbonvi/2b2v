const sessions = new Set<string>();

export function createDashboardSession(): string {
  const token = crypto.randomUUID() + crypto.randomUUID();
  sessions.add(token);
  return token;
}

function getSessionFromCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie");
  if (cookie === null) return null;
  const match = cookie.match(/session=([^;]+)/);
  return match !== null ? (match[1] ?? null) : null;
}

export function isDashboardAuthenticated(req: Request): boolean {
  const token = getSessionFromCookie(req);
  return token !== null && sessions.has(token);
}

export function parseDashboardPasswordlessCidrs(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function stripIpDecorators(value: string): string {
  let ip = value.trim().replace(/^"|"$/g, "");
  if (ip.startsWith("[") && ip.includes("]")) {
    ip = ip.slice(1, ip.indexOf("]"));
  }
  if (ip.toLowerCase().startsWith("::ffff:")) {
    ip = ip.slice("::ffff:".length);
  }
  const colonIndex = ip.indexOf(":");
  if (colonIndex !== -1 && ip.indexOf(":") === ip.lastIndexOf(":") && ip.includes(".")) {
    ip = ip.slice(0, colonIndex);
  }
  return ip;
}

function parseIpv4(value: string): number | null {
  const ip = stripIpDecorators(value);
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    return octet >= 0 && octet <= 255 ? octet : null;
  });
  if (octets.some((octet) => octet === null)) return null;

  const [a, b, c, d] = octets as [number, number, number, number];
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}

export function isIpv4InCidr(ip: string, cidr: string): boolean {
  const ipNum = parseIpv4(ip);
  if (ipNum === null) return false;

  const [baseRaw, prefixRaw = "32"] = cidr.split("/");
  if (baseRaw === undefined || baseRaw.trim() === "") return false;
  if (!/^\d{1,2}$/.test(prefixRaw)) return false;
  const prefix = Number(prefixRaw);
  if (prefix < 0 || prefix > 32) return false;

  const baseNum = parseIpv4(baseRaw);
  if (baseNum === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function forwardedHeaderIps(value: string): string[] {
  const ips: string[] = [];
  for (const part of value.split(",")) {
    const match = /(?:^|;)\s*for=(?:"?\[?)([^";,\]\s]+)(?:\]?"?)/i.exec(part);
    if (match?.[1] !== undefined) ips.push(match[1]);
  }
  return ips.reverse();
}

function isTrustedProxyAddress(socketAddress: string | undefined, cidrs: readonly string[]): boolean {
  if (socketAddress === undefined || socketAddress === "") return false;
  const ip = stripIpDecorators(socketAddress);
  if (ip === "::1") return true;
  return cidrs.some((cidr) => isIpv4InCidr(ip, cidr));
}

function rightmostForwardedValue(value: string): string | undefined {
  const parts = value
    .split(",")
    .map((ip) => ip.trim())
    .filter((ip) => ip !== "");
  return parts.at(-1);
}

function forwardedClientIp(req: Request): string | undefined {
  const xForwardedFor = req.headers.get("x-forwarded-for");
  if (xForwardedFor !== null) {
    const ip = rightmostForwardedValue(xForwardedFor);
    if (ip !== undefined) return ip;
  }

  const forwarded = req.headers.get("forwarded");
  if (forwarded !== null) {
    return forwardedHeaderIps(forwarded)[0];
  }

  return undefined;
}

export function requestClientIpCandidates(
  req: Request,
  socketAddress?: string,
  trustedProxyCidrs: readonly string[] = [],
): string[] {
  const ips: string[] = [];
  if (isTrustedProxyAddress(socketAddress, trustedProxyCidrs)) {
    const forwardedIp = forwardedClientIp(req);
    if (forwardedIp !== undefined) ips.push(forwardedIp);
  }
  if (socketAddress !== undefined && socketAddress !== "") ips.push(socketAddress);
  return ips.map(stripIpDecorators).filter((ip) => ip !== "");
}

export function isPasswordlessDashboardRequest(
  req: Request,
  cidrs: readonly string[],
  socketAddress?: string,
  trustedProxyCidrs: readonly string[] = [],
): boolean {
  if (cidrs.length === 0) return false;
  return requestClientIpCandidates(req, socketAddress, trustedProxyCidrs)
    .some((ip) => cidrs.some((cidr) => isIpv4InCidr(ip, cidr)));
}
