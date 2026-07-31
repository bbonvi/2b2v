import type { Logger } from "../logger";
import { isDashboardAuthenticated, isPasswordlessDashboardRequest } from "./auth";
import { createDashboardRoutes, type DashboardManagementApi } from "./routes";

interface DashboardOptions {
  port: number;
  password: string;
  bypassAuth?: boolean;
  passwordlessCidrs?: string[];
  trustedProxyCidrs?: string[];
  management?: DashboardManagementApi;
  log?: Logger;
}

export function startDashboard(opts: DashboardOptions): ReturnType<typeof Bun.serve> {
  const { port, password, bypassAuth = false, passwordlessCidrs = [], trustedProxyCidrs = [], management, log } = opts;
  const isAuthBypassed = (req: Request): boolean => bypassAuth || isPasswordlessDashboardRequest(
    req,
    passwordlessCidrs,
    server.requestIP(req)?.address,
    trustedProxyCidrs,
  );
  const requireAuth = (req: Request): Response | null => {
    if (isAuthBypassed(req)) return null;
    return isDashboardAuthenticated(req) ? null : new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };
  const server = Bun.serve({
    port,
    idleTimeout: 255,
    routes: createDashboardRoutes({ password, management, requireAuth, isAuthBypassed }),
    fetch: () => new Response("Not found", { status: 404 }),
  });
  log?.info("dashboard started", { port });
  return server;
}
