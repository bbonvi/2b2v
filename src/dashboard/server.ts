import { requestLogStore } from "./store";
import type { Logger } from "../logger";
import dashboard from "./index.html";

const DASHBOARD_LOG_ENTRY_LIMIT = 100;

interface DashboardOptions {
  port: number;
  password: string;
  bypassAuth?: boolean;
  passwordlessCidrs?: string[];
  trustedProxyCidrs?: string[];
  log?: Logger;
}

const sessions = new Set<string>();

function generateToken(): string {
  return crypto.randomUUID() + crypto.randomUUID();
}

function getSessionFromCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie");
  if (cookie === null) return null;
  const match = cookie.match(/session=([^;]+)/);
  return match !== null ? (match[1] ?? null) : null;
}

function isAuthenticated(req: Request): boolean {
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

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function requestLogFilters(req: Request): { guildId?: string; channelId?: string; authorUsername?: string } {
  const url = new URL(req.url);
  const filters: { guildId?: string; channelId?: string; authorUsername?: string } = {};
  const guildId = url.searchParams.get("guildId");
  const channelId = url.searchParams.get("channelId");
  const authorUsername = url.searchParams.get("authorUsername");
  if (guildId !== null && guildId !== "") filters.guildId = guildId;
  if (channelId !== null && channelId !== "") filters.channelId = channelId;
  if (authorUsername !== null && authorUsername !== "") filters.authorUsername = authorUsername;
  return filters;
}

export function startDashboard(opts: DashboardOptions): void {
  const { port, password, bypassAuth = false, passwordlessCidrs = [], trustedProxyCidrs = [], log } = opts;

  function requestSocketAddress(req: Request): string | undefined {
    return server.requestIP(req)?.address;
  }

  function isAuthBypassed(req: Request): boolean {
    return bypassAuth || isPasswordlessDashboardRequest(
      req,
      passwordlessCidrs,
      requestSocketAddress(req),
      trustedProxyCidrs,
    );
  }

  function requireAuth(req: Request): Response | null {
    if (isAuthBypassed(req)) return null;
    if (!isAuthenticated(req)) return json({ error: "Unauthorized" }, 401);
    return null;
  }

  const server = Bun.serve({
    port,
    routes: {
      "/login": (req) => {
        if (isAuthBypassed(req)) return Response.redirect("/", 302);
        return new Response(loginHtml, {
          headers: { "content-type": "text/html" },
        });
      },

      "/api/auth": {
        POST: async (req) => {
          const body = await req.json() as { password?: string };
          if (body.password !== password) {
            return json({ error: "Invalid password" }, 401);
          }
          const token = generateToken();
          sessions.add(token);
          return json({ ok: true }, 200, {
            "set-cookie": `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`,
          });
        },
      },

      "/api/logs": (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        return json(requestLogStore.querySummaries(requestLogFilters(req), DASHBOARD_LOG_ENTRY_LIMIT));
      },

      "/api/logs/:requestId": (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const entry = requestLogStore.getByRequestId(req.params.requestId);
        if (entry === null) return json({ error: "Log entry not found" }, 404);
        return json(entry);
      },

      "/api/filters": (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        return json(requestLogStore.getFilterOptions());
      },

      "/api/status": (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        return json({ activeRequests: requestLogStore.getActiveCount() });
      },

      "/": {
        GET: (req) => {
          if (!isAuthBypassed(req) && !isAuthenticated(req)) {
            return Response.redirect("/login", 302);
          }
          return new Response(Bun.file(dashboard.index).stream(), {
            headers: { "content-type": "text/html" },
          });
        },
      },
    },

    fetch(_req) {
      return new Response("Not found", { status: 404 });
    },
  });

  log?.info("dashboard started", { port });
}

const loginHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login — Request Dashboard</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{
    font-family:'JetBrains Mono',monospace;
    background:#0a0a0a;
    color:#c8c8c8;
    display:flex;align-items:center;justify-content:center;
    min-height:100vh;
  }
  .login-box{
    background:#111;border:1px solid #2a2a2a;
    padding:2.5rem;width:340px;
  }
  h1{font-size:.85rem;text-transform:uppercase;letter-spacing:.15em;color:#666;margin-bottom:1.5rem}
  input{
    width:100%;padding:.65rem .8rem;
    background:#0a0a0a;border:1px solid #333;color:#e0e0e0;
    font-family:inherit;font-size:.8rem;
    margin-bottom:1rem;outline:none;
  }
  input:focus{border-color:#4a9eff}
  button{
    width:100%;padding:.65rem;
    background:#4a9eff;border:none;color:#000;
    font-family:inherit;font-size:.75rem;font-weight:600;
    text-transform:uppercase;letter-spacing:.1em;cursor:pointer;
  }
  button:hover{background:#6bb3ff}
  .err{color:#ff4a4a;font-size:.7rem;margin-bottom:.8rem;display:none}
</style>
</head>
<body>
<div class="login-box">
  <h1>Request Dashboard</h1>
  <div class="err" id="err">Invalid password</div>
  <form id="f">
    <input type="password" name="password" placeholder="Password" autofocus>
    <button type="submit">Authenticate</button>
  </form>
</div>
<script>
document.getElementById('f').onsubmit=async e=>{
  e.preventDefault();
  const pw=e.target.password.value;
  const r=await fetch('/api/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:pw})});
  if(r.ok){location.href='/'}
  else{const el=document.getElementById('err');el.style.display='block'}
};
</script>
</body>
</html>`;
