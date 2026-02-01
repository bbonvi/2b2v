import { requestLogStore } from "./store";
import type { Logger } from "../logger";
import dashboard from "./index.html";

interface DashboardOptions {
  port: number;
  password: string;
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

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function startDashboard(opts: DashboardOptions): void {
  const { port, password, log } = opts;

  Bun.serve({
    port,
    routes: {
      "/login": () => {
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
        if (!isAuthenticated(req)) return json({ error: "Unauthorized" }, 401);
        const url = new URL(req.url);
        const filters: { guildId?: string; channelId?: string; authorUsername?: string } = {};
        const guildId = url.searchParams.get("guildId");
        const channelId = url.searchParams.get("channelId");
        const authorUsername = url.searchParams.get("authorUsername");
        if (guildId !== null && guildId !== "") filters.guildId = guildId;
        if (channelId !== null && channelId !== "") filters.channelId = channelId;
        if (authorUsername !== null && authorUsername !== "") filters.authorUsername = authorUsername;
        return json(requestLogStore.query(filters));
      },

      "/api/filters": (req) => {
        if (!isAuthenticated(req)) return json({ error: "Unauthorized" }, 401);
        return json(requestLogStore.getFilterOptions());
      },

      "/api/status": (req) => {
        if (!isAuthenticated(req)) return json({ error: "Unauthorized" }, 401);
        return json({ activeRequests: requestLogStore.getActiveCount() });
      },

      "/": {
        GET: (req) => {
          if (!isAuthenticated(req)) {
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
