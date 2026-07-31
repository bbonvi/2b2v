import { requestLogStore } from "./store";
import { isMemoryKind } from "../db/memory-repository";
import { isPromptScenarioId, type PromptScenarioId } from "../config/prompt-inspector";
import type { NotebookState } from "../db/notebook-repository";
import { relativeDurationToMilliseconds } from "../time/relative-duration";
import dashboard from "./index.html";
import type { ManagementDirectory, ManagementMemoryCreateInput, ManagementMemoryEditInput, ManagementMemoryFilter } from "./management";
import { createDashboardSession, isDashboardAuthenticated } from "./auth";

const DASHBOARD_LOG_ENTRY_LIMIT = 100;

type DashboardManagementResult = object;
type AwaitableDashboardManagementResult = DashboardManagementResult | Promise<DashboardManagementResult>;

export interface DashboardManagementApi {
  getPersonaModeStatus?: () => AwaitableDashboardManagementResult;
  getDirectory: () => ManagementDirectory | Promise<ManagementDirectory>;
  listMessages: (filter: { guildId?: string; channelId?: string; limit?: number }) => AwaitableDashboardManagementResult;
  editMessage: (input: { messageId: string; guildId: string; channelId: string; content: string }) => AwaitableDashboardManagementResult;
  deleteMessages: (input: { messageIds: string[]; guildId: string; channelId: string; deleteDiscord?: boolean }) => AwaitableDashboardManagementResult;
  deleteLatestMessages: (input: { guildId: string; channelId: string; count: number; deleteDiscord?: boolean }) => AwaitableDashboardManagementResult;
  inspectPrompts: (input: {
    scenario: PromptScenarioId;
    provider: "openai-codex" | "openrouter";
    guildId?: string;
  }) => AwaitableDashboardManagementResult;
  runPromptLab: (input: {
    guildId: string;
    channelId: string;
    userId: string;
    content: string;
    runToken?: string;
  }) => AwaitableDashboardManagementResult;
  runPromptLabAmbientInitiative: (input: { guildId: string; channelId: string; force?: boolean; runToken?: string }) => AwaitableDashboardManagementResult;
  runPromptLabPrivateLife: (input: {
    guildId: string;
    channelId: string;
    origin?: string;
    mode?: string;
    territory?: string;
    actionScope?: string;
  }) => AwaitableDashboardManagementResult;
  listPrivateLifeEpisodes: (limit?: number) => AwaitableDashboardManagementResult;
  listInnerThreads: (filter: { guildId?: string; status?: "active" | "resolved"; limit?: number }) => AwaitableDashboardManagementResult;
  deleteInnerThread: (threadId: string) => AwaitableDashboardManagementResult;
  listStagedAssets: (filter: { guildId?: string; channelId?: string; unresolvedOnly?: boolean; limit?: number }) => AwaitableDashboardManagementResult;
  listMemories: (filter: ManagementMemoryFilter) => AwaitableDashboardManagementResult;
  createMemory: (input: ManagementMemoryCreateInput) => AwaitableDashboardManagementResult;
  editMemory: (input: ManagementMemoryEditInput) => AwaitableDashboardManagementResult;
  deleteMemory: (memoryId: number) => AwaitableDashboardManagementResult;
  restoreMemory: (memoryId: number) => AwaitableDashboardManagementResult;
  listNotebooks: () => AwaitableDashboardManagementResult;
  createNotebook: (input: { title: string; content: string; shelfAfterMs?: number }) => AwaitableDashboardManagementResult;
  editNotebook: (input: {
    notebookId: number;
    expectedRevision: number;
    title: string;
    content: string;
    shelfAfterMs: number;
  }) => AwaitableDashboardManagementResult;
  setNotebookState: (input: {
    notebookId: number;
    expectedRevision: number;
    targetState: Exclude<NotebookState, "trashed">;
  }) => AwaitableDashboardManagementResult;
  deleteNotebook: (input: { notebookId: number; expectedRevision: number }) => AwaitableDashboardManagementResult;
  relationships: {
    getOverview: (input?: { userId?: string }) => AwaitableDashboardManagementResult;
    reset: (input?: { userId?: string }) => AwaitableDashboardManagementResult;
  };
  voice?: {
    getSnapshot: () => AwaitableDashboardManagementResult;
    subscribe: (listener: (snapshot: object) => void) => () => void;
    listChannels: () => AwaitableDashboardManagementResult;
    join: (channelId: string) => AwaitableDashboardManagementResult;
    leave: () => AwaitableDashboardManagementResult;
    inject: (text: string) => AwaitableDashboardManagementResult;
  };
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch((): null => null);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}

function optionalStringParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value !== null && value.trim() !== "" ? value.trim() : undefined;
}

function optionalNumberParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalBooleanParam(url: URL, name: string): boolean | undefined {
  const value = url.searchParams.get(name);
  if (value === null || value.trim() === "") return undefined;
  return value === "true" || value === "1";
}

function optionalMemoryAbout(url: URL): "community" | "user" | "self" | undefined {
  const value = optionalStringParam(url, "about");
  return value === "community" || value === "user" || value === "self" ? value : undefined;
}

function optionalMemoryStatus(url: URL): "active" | "expired" | "deleted" | "all" | undefined {
  const value = optionalStringParam(url, "status");
  return value === "active" || value === "expired" || value === "deleted" || value === "all" ? value : undefined;
}

function optionalRecallMode(url: URL): "always" | "users" | undefined {
  const value = optionalStringParam(url, "recallMode");
  return value === "always" || value === "users" ? value : undefined;
}

function optionalRecallScope(url: URL): "anywhere" | "guild" | undefined {
  const value = optionalStringParam(url, "recallScope");
  return value === "anywhere" || value === "guild" ? value : undefined;
}

function parseMemoryMutationBody(body: Record<string, unknown>): Omit<ManagementMemoryEditInput, "memoryId"> {
  const result: Omit<ManagementMemoryEditInput, "memoryId"> = {};
  if ("about" in body) {
    if (body.about !== "community" && body.about !== "user" && body.about !== "self") throw new Error("Invalid memory subject.");
    result.about = body.about;
  }
  if ("recallIn" in body) {
    if (body.recallIn === "anywhere") {
      result.recallIn = "anywhere";
    } else if (body.recallIn !== null && typeof body.recallIn === "object" && !Array.isArray(body.recallIn)
      && typeof (body.recallIn as { guildId?: unknown }).guildId === "string"
      && (body.recallIn as { guildId: string }).guildId.trim() !== "") {
      result.recallIn = { guildId: (body.recallIn as { guildId: string }).guildId.trim() };
    } else {
      throw new Error("recallIn must be 'anywhere' or a guild object.");
    }
  }
  if ("aboutUserId" in body) {
    if (typeof body.aboutUserId !== "string" && body.aboutUserId !== null) throw new Error("aboutUserId must be a string or null.");
    result.aboutUserId = typeof body.aboutUserId === "string" ? body.aboutUserId.trim() : null;
  }
  if ("recallWhen" in body) {
    if (body.recallWhen === "always") {
      result.recallWhen = "always";
    } else if (Array.isArray(body.recallWhen) && body.recallWhen.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
      result.recallWhen = [...new Set(body.recallWhen.map((entry) => String(entry).trim()))];
    } else {
      throw new Error("recallWhen must be 'always' or a non-empty user ID list.");
    }
  }
  if ("kind" in body) {
    if (!isMemoryKind(body.kind)) throw new Error("Invalid memory kind.");
    result.kind = body.kind;
  }
  if ("content" in body) {
    if (typeof body.content !== "string") throw new Error("content must be a string.");
    result.content = body.content;
  }
  if ("sourceMessageId" in body) {
    if (typeof body.sourceMessageId !== "string" && body.sourceMessageId !== null) throw new Error("sourceMessageId must be a string or null.");
    result.sourceMessageId = typeof body.sourceMessageId === "string" && body.sourceMessageId.trim() !== "" ? body.sourceMessageId.trim() : null;
  }
  if ("provenance" in body) {
    if (body.provenance !== null && (typeof body.provenance !== "object" || Array.isArray(body.provenance))) {
      throw new Error("provenance must be an object or null.");
    }
    result.provenance = body.provenance as Record<string, unknown> | null;
  }
  if ("confidence" in body) {
    if (typeof body.confidence !== "number") throw new Error("confidence must be a number.");
    result.confidence = body.confidence;
  }
  if ("priority" in body) {
    if (typeof body.priority !== "number") throw new Error("priority must be a number.");
    result.priority = body.priority;
  }
  if ("importantUntil" in body) {
    if (typeof body.importantUntil !== "number" && body.importantUntil !== null) throw new Error("importantUntil must be a timestamp or null.");
    result.importantUntil = body.importantUntil;
  }
  if ("expiresAt" in body) {
    if (typeof body.expiresAt !== "number" && body.expiresAt !== null) throw new Error("expiresAt must be a timestamp or null.");
    result.expiresAt = body.expiresAt;
  }
  return result;
}

function notebookIdParam(value: string): number | null {
  const notebookId = Number(value);
  return Number.isInteger(notebookId) && notebookId > 0 ? notebookId : null;
}

function expectedNotebookRevision(body: Record<string, unknown>): number {
  if (typeof body.expectedRevision !== "number"
    || !Number.isInteger(body.expectedRevision)
    || body.expectedRevision < 1) {
    throw new Error("expectedRevision must be a positive integer.");
  }
  return body.expectedRevision;
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

const dashboardAssetBundles = new Map<string, { body: string; headers: Record<string, string> }>();

async function dashboardAssetResponse(entrypoint: string, label: string): Promise<Response> {
  let bundle = dashboardAssetBundles.get(entrypoint);
  if (bundle === undefined) {
    const result = await Bun.build({
      entrypoints: [new URL(entrypoint, import.meta.url).pathname],
      target: "browser",
      format: "esm",
      sourcemap: "none",
    });
    if (!result.success) {
      return json({ error: `${label} bundle failed`, logs: result.logs.map((entry) => entry.message) }, 500);
    }
    const output = result.outputs[0];
    if (output === undefined) return json({ error: `${label} bundle was empty` }, 500);
    bundle = {
      body: await output.text(),
      headers: { "content-type": "text/javascript; charset=utf-8" },
    };
    dashboardAssetBundles.set(entrypoint, bundle);
  }
  return new Response(bundle.body, { headers: bundle.headers });
}

type DashboardRoute
  = "/login"
  | "/api/auth"
  | "/api/logs"
  | "/api/logs/:requestId"
  | "/api/log-groups"
  | "/api/log-groups/:groupId"
  | "/api/filters"
  | "/api/status"
  | "/api/persona-modes"
  | "/api/management/directory"
  | "/api/management/prompts"
  | "/api/management/messages"
  | "/api/management/messages/:messageId"
  | "/api/management/messages/delete-latest"
  | "/api/management/messages/delete-selected"
  | "/api/management/prompt-lab/run"
  | "/api/management/prompt-lab/ambient-initiative"
  | "/api/management/prompt-lab/private-life"
  | "/api/management/private-life"
  | "/api/management/inner-threads"
  | "/api/management/inner-threads/:threadId"
  | "/api/management/staged-assets"
  | "/api/management/notebooks"
  | "/api/management/notebooks/:notebookId"
  | "/api/management/notebooks/:notebookId/state"
  | "/api/management/memories"
  | "/api/management/memories/:memoryId"
  | "/api/management/memories/:memoryId/restore"
  | "/api/relationships"
  | "/api/relationships/reset"
  | "/api/voice"
  | "/api/voice/channels"
  | "/api/voice/live"
  | "/api/voice/join"
  | "/api/voice/leave"
  | "/api/voice/inject"
  | "/assets/voice-tab.js"
  | "/assets/relationships-lab.js"
  | "/assets/memories-tab.js"
  | "/assets/notebooks-tab.js"
  | "/assets/prompts-tab.js"
  | "/";

export function createDashboardRoutes(input: {
  password: string;
  management?: DashboardManagementApi;
  requireAuth: (req: Request) => Response | null;
  isAuthBypassed: (req: Request) => boolean;
}): Bun.Serve.Routes<undefined, DashboardRoute> {
  const { password, management, requireAuth, isAuthBypassed } = input;
  return {
      "/login": (req) => {
        if (isAuthBypassed(req)) return Response.redirect("/", 302);
        return new Response(Bun.file(new URL("./login.html", import.meta.url)).stream(), {
          headers: { "content-type": "text/html" },
        });
      },

      "/api/auth": {
        POST: async (req) => {
          const body = await req.json() as { password?: string };
          if (body.password !== password) {
            return json({ error: "Invalid password" }, 401);
          }
          const token = createDashboardSession();
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
        const entry = requestLogStore.getSanitizedByRequestId(req.params.requestId);
        if (entry === null) return json({ error: "Log entry not found" }, 404);
        return json(entry);
      },

      "/api/log-groups": (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        return json(requestLogStore.queryGroups(requestLogFilters(req), DASHBOARD_LOG_ENTRY_LIMIT));
      },

      "/api/log-groups/:groupId": (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        const group = requestLogStore.getSanitizedGroup(req.params.groupId);
        if (group === null) return json({ error: "Log group not found" }, 404);
        return json(group);
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

      "/api/persona-modes": async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        if (management?.getPersonaModeStatus === undefined) return json({ error: "Persona modes are unavailable" }, 404);
        return json(await management.getPersonaModeStatus());
      },

      "/api/management/directory": async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        if (management === undefined) return json({ error: "Management API is disabled" }, 404);
        return json(await management.getDirectory());
      },

      "/api/management/prompts": async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        if (management === undefined) return json({ error: "Management API is disabled" }, 404);
        const url = new URL(req.url);
        const scenario = url.searchParams.get("scenario") ?? "discord";
        const provider = url.searchParams.get("provider") ?? "openai-codex";
        const guildId = optionalStringParam(url, "guildId");
        if (!isPromptScenarioId(scenario)) return json({ error: `Unknown prompt scenario: ${scenario}` }, 400);
        if (provider !== "openai-codex" && provider !== "openrouter") {
          return json({ error: `Unknown provider: ${provider}` }, 400);
        }
        return json(await management.inspectPrompts({
          scenario,
          provider,
          ...(guildId !== undefined ? { guildId } : {}),
        }));
      },

      "/api/management/messages": async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        if (management === undefined) return json({ error: "Management API is disabled" }, 404);
        const url = new URL(req.url);
        return json(await management.listMessages({
          guildId: optionalStringParam(url, "guildId"),
          channelId: optionalStringParam(url, "channelId"),
          limit: optionalNumberParam(url, "limit"),
        }));
      },

      "/api/management/messages/:messageId": {
        PATCH: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          try {
            const body = await readJsonObject(req);
            const guildId = typeof body.guildId === "string" ? body.guildId.trim() : "";
            const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
            const content = typeof body.content === "string" ? body.content : "";
            if (guildId === "" || channelId === "" || content.trim() === "") {
              return json({ error: "messageId, guildId, channelId, and non-empty content are required." }, 400);
            }
            return json(await management.editMessage({
              messageId: req.params.messageId,
              guildId,
              channelId,
              content,
            }));
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
        },
        DELETE: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          const url = new URL(req.url);
          const guildId = optionalStringParam(url, "guildId");
          const channelId = optionalStringParam(url, "channelId");
          if (guildId === undefined || channelId === undefined) {
            return json({ error: "guildId and channelId are required." }, 400);
          }
          return json(await management.deleteMessages({
            messageIds: [req.params.messageId],
            guildId,
            channelId,
            deleteDiscord: optionalBooleanParam(url, "deleteDiscord") === true,
          }));
        },
      },

      "/api/management/messages/delete-latest": {
        POST: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          try {
            const body = await readJsonObject(req);
            const guildId = typeof body.guildId === "string" ? body.guildId.trim() : "";
            const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
            const count = typeof body.count === "number" ? body.count : Number(body.count);
            if (guildId === "" || channelId === "" || !Number.isFinite(count)) {
              return json({ error: "guildId, channelId, and count are required." }, 400);
            }
            return json(await management.deleteLatestMessages({
              guildId,
              channelId,
              count,
              deleteDiscord: body.deleteDiscord === true,
            }));
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
        },
      },

      "/api/management/messages/delete-selected": {
        POST: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          try {
            const body = await readJsonObject(req);
            const guildId = typeof body.guildId === "string" ? body.guildId.trim() : "";
            const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
            const messageIds = Array.isArray(body.messageIds)
              ? body.messageIds.filter((id): id is string => typeof id === "string" && id.trim() !== "")
              : [];
            if (guildId === "" || channelId === "" || messageIds.length === 0) {
              return json({ error: "guildId, channelId, and messageIds are required." }, 400);
            }
            return json(await management.deleteMessages({
              guildId,
              channelId,
              messageIds,
              deleteDiscord: body.deleteDiscord === true,
            }));
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
        },
      },

      "/api/management/prompt-lab/run": {
        POST: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          try {
            const body = await readJsonObject(req);
            const guildId = typeof body.guildId === "string" ? body.guildId.trim() : "";
            const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
            const userId = typeof body.userId === "string" ? body.userId.trim() : "";
            const content = typeof body.content === "string" ? body.content.trim() : "";
            const runToken = typeof body.runToken === "string" ? body.runToken.trim() : "";
            if (guildId === "" || channelId === "" || userId === "" || content === "") {
              return json({ error: "guildId, channelId, userId, and non-empty content are required." }, 400);
            }
            return json(await management.runPromptLab({
              guildId,
              channelId,
              userId,
              content,
              ...(runToken !== "" ? { runToken } : {}),
            }));
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
        },
      },

      "/api/management/prompt-lab/ambient-initiative": {
        POST: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          try {
            const body = await readJsonObject(req);
            const guildId = typeof body.guildId === "string" ? body.guildId.trim() : "";
            const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
            const force = body.force === true;
            const runToken = typeof body.runToken === "string" ? body.runToken.trim() : "";
            if (guildId === "" || channelId === "") {
              return json({ error: "guildId and channelId are required." }, 400);
            }
            return json(await management.runPromptLabAmbientInitiative({
              guildId,
              channelId,
              force,
              ...(runToken !== "" ? { runToken } : {}),
            }));
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
        },
      },

      "/api/management/prompt-lab/private-life": {
        POST: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          try {
            const body = await readJsonObject(req);
            const guildId = typeof body.guildId === "string" ? body.guildId.trim() : "";
            const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
            if (guildId === "" || channelId === "") {
              return json({ error: "guildId and channelId are required." }, 400);
            }
            return json(await management.runPromptLabPrivateLife({
              guildId,
              channelId,
              ...(typeof body.origin === "string" && body.origin.trim() !== "" ? { origin: body.origin.trim() } : {}),
              ...(typeof body.mode === "string" && body.mode.trim() !== "" ? { mode: body.mode.trim() } : {}),
              ...(typeof body.territory === "string" && body.territory.trim() !== "" ? { territory: body.territory.trim() } : {}),
              ...(typeof body.actionScope === "string" && body.actionScope.trim() !== "" ? { actionScope: body.actionScope.trim() } : {}),
            }));
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
        },
      },

      "/api/management/private-life": {
        GET: (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          const limit = optionalNumberParam(new URL(req.url), "limit");
          return Promise.resolve(management.listPrivateLifeEpisodes(limit)).then(json);
        },
      },

      "/api/management/inner-threads": {
        GET: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          const url = new URL(req.url);
          const status = optionalStringParam(url, "status");
          return json(await management.listInnerThreads({
            guildId: optionalStringParam(url, "guildId"),
            ...(status === "active" || status === "resolved" ? { status } : {}),
            limit: optionalNumberParam(url, "limit"),
          }));
        },
      },

      "/api/management/inner-threads/:threadId": {
        DELETE: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          const threadId = req.params.threadId.trim();
          if (threadId === "") return json({ error: "Valid threadId is required." }, 400);
          return json(await management.deleteInnerThread(threadId));
        },
      },

      "/api/management/staged-assets": {
        GET: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          const url = new URL(req.url);
          return json(await management.listStagedAssets({
            guildId: optionalStringParam(url, "guildId"),
            channelId: optionalStringParam(url, "channelId"),
            unresolvedOnly: url.searchParams.get("unresolvedOnly") !== "false",
            limit: optionalNumberParam(url, "limit"),
          }));
        },
      },

      "/api/management/notebooks": {
        GET: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          return json(await management.listNotebooks());
        },
        POST: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          try {
            const body = await readJsonObject(req);
            const title = typeof body.title === "string" ? body.title.trim() : "";
            const content = typeof body.content === "string" ? body.content : "";
            if (title === "") return json({ error: "title is required." }, 400);
            return json(await management.createNotebook({
              title,
              content,
              ...("shelfAfter" in body
                ? { shelfAfterMs: relativeDurationToMilliseconds(body.shelfAfter) }
                : {}),
            }));
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
        },
      },

      "/api/management/notebooks/:notebookId": {
        PATCH: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          try {
            const notebookId = notebookIdParam(req.params.notebookId);
            if (notebookId === null) return json({ error: "Valid notebookId is required." }, 400);
            const body = await readJsonObject(req);
            const title = typeof body.title === "string" ? body.title.trim() : "";
            if (title === "" || typeof body.content !== "string" || !("shelfAfter" in body)) {
              return json({ error: "title, content, shelfAfter, and expectedRevision are required." }, 400);
            }
            return json(await management.editNotebook({
              notebookId,
              expectedRevision: expectedNotebookRevision(body),
              title,
              content: body.content,
              shelfAfterMs: relativeDurationToMilliseconds(body.shelfAfter),
            }));
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
        },
        DELETE: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          try {
            const notebookId = notebookIdParam(req.params.notebookId);
            if (notebookId === null) return json({ error: "Valid notebookId is required." }, 400);
            return json(await management.deleteNotebook({
              notebookId,
              expectedRevision: expectedNotebookRevision(await readJsonObject(req)),
            }));
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
        },
      },

      "/api/management/notebooks/:notebookId/state": {
        POST: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          try {
            const notebookId = notebookIdParam(req.params.notebookId);
            if (notebookId === null) return json({ error: "Valid notebookId is required." }, 400);
            const body = await readJsonObject(req);
            const targetState = body.targetState;
            if (targetState !== "active" && targetState !== "shelved" && targetState !== "archived") {
              return json({ error: "targetState must be active, shelved, or archived." }, 400);
            }
            return json(await management.setNotebookState({
              notebookId,
              expectedRevision: expectedNotebookRevision(body),
              targetState,
            }));
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
        },
      },

      "/api/management/memories": {
        GET: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          const url = new URL(req.url);
          const kind = optionalStringParam(url, "kind");
          return json(await management.listMemories({
            guildId: optionalStringParam(url, "guildId"),
            channelId: optionalStringParam(url, "channelId"),
            about: optionalMemoryAbout(url),
            ...(kind !== undefined && isMemoryKind(kind) ? { kind } : {}),
            aboutUserId: optionalStringParam(url, "aboutUserId"),
            relevantUserId: optionalStringParam(url, "relevantUserId"),
            recallMode: optionalRecallMode(url),
            recallScope: optionalRecallScope(url),
            important: optionalBooleanParam(url, "important"),
            status: optionalMemoryStatus(url),
            query: optionalStringParam(url, "query"),
            limit: optionalNumberParam(url, "limit"),
          }));
        },
        POST: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          try {
            const parsed = parseMemoryMutationBody(await readJsonObject(req));
            if (parsed.about === undefined || parsed.recallIn === undefined || parsed.recallWhen === undefined || parsed.kind === undefined
              || parsed.content === undefined || parsed.confidence === undefined || parsed.priority === undefined) {
              return json({ error: "about, recallIn, recallWhen, kind, content, confidence, and priority are required." }, 400);
            }
            return json(await management.createMemory({
              about: parsed.about,
              recallIn: parsed.recallIn,
              recallWhen: parsed.recallWhen,
              kind: parsed.kind,
              content: parsed.content,
              confidence: parsed.confidence,
              priority: parsed.priority,
              ...(parsed.aboutUserId !== undefined ? { aboutUserId: parsed.aboutUserId } : {}),
              ...(parsed.sourceMessageId !== undefined ? { sourceMessageId: parsed.sourceMessageId } : {}),
              ...(parsed.provenance !== undefined ? { provenance: parsed.provenance } : {}),
              ...(parsed.importantUntil !== undefined ? { importantUntil: parsed.importantUntil } : {}),
              ...(parsed.expiresAt !== undefined ? { expiresAt: parsed.expiresAt } : {}),
            }));
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
        },
      },

      "/api/management/memories/:memoryId": {
        PATCH: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          try {
            const memoryId = Number(req.params.memoryId);
            if (!Number.isInteger(memoryId) || memoryId <= 0) return json({ error: "Valid memoryId is required." }, 400);
            return json(await management.editMemory({
              memoryId,
              ...parseMemoryMutationBody(await readJsonObject(req)),
            }));
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
        },
        DELETE: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          const memoryId = Number(req.params.memoryId);
          if (!Number.isInteger(memoryId) || memoryId <= 0) return json({ error: "Valid memoryId is required." }, 400);
          return json(await management.deleteMemory(memoryId));
        },
      },

      "/api/management/memories/:memoryId/restore": {
        POST: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          try {
            const memoryId = Number(req.params.memoryId);
            if (!Number.isInteger(memoryId) || memoryId <= 0) return json({ error: "Valid memoryId is required." }, 400);
            return json(await management.restoreMemory(memoryId));
          } catch (err) {
            return json({ error: err instanceof Error ? err.message : String(err) }, 400);
          }
        },
      },

      "/api/relationships": (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        if (management === undefined) return json({ error: "Management API is disabled" }, 404);
        const url = new URL(req.url);
        return json(management.relationships.getOverview({ userId: optionalStringParam(url, "userId") }));
      },

      "/api/relationships/reset": {
        POST: (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management === undefined) return json({ error: "Management API is disabled" }, 404);
          const url = new URL(req.url);
          return json(management.relationships.reset({ userId: optionalStringParam(url, "userId") }));
        },
      },

      "/api/voice": async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        if (management?.voice === undefined) return json({ error: "Live voice is unavailable" }, 404);
        return json(await management.voice.getSnapshot());
      },

      "/api/voice/channels": async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        if (management?.voice === undefined) return json({ error: "Live voice is unavailable" }, 404);
        return json(await management.voice.listChannels());
      },

      "/api/voice/live": (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        if (management?.voice === undefined) return json({ error: "Live voice is unavailable" }, 404);
        let unsubscribe = (): void => {};
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            const send = (snapshot: object): void => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`));
            };
            const voice = management.voice;
            if (voice === undefined) return;
            void Promise.resolve(voice.getSnapshot()).then((snapshot) => send(snapshot));
            unsubscribe = voice.subscribe(send);
            heartbeat = setInterval(() => {
              controller.enqueue(encoder.encode(": keepalive\n\n"));
            }, 15_000);
          },
          cancel() {
            unsubscribe();
            if (heartbeat !== undefined) clearInterval(heartbeat);
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      },

      "/api/voice/join": {
        POST: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management?.voice === undefined) return json({ error: "Live voice is unavailable" }, 404);
          try {
            const body = await readJsonObject(req);
            const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
            if (channelId === "") return json({ error: "channelId is required" }, 400);
            return json(await management.voice.join(channelId));
          } catch (error) {
            return json({ error: error instanceof Error ? error.message : String(error) }, 400);
          }
        },
      },

      "/api/voice/leave": {
        POST: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management?.voice === undefined) return json({ error: "Live voice is unavailable" }, 404);
          try {
            return json(await management.voice.leave());
          } catch (error) {
            return json({ error: error instanceof Error ? error.message : String(error) }, 400);
          }
        },
      },

      "/api/voice/inject": {
        POST: async (req) => {
          const denied = requireAuth(req);
          if (denied !== null) return denied;
          if (management?.voice === undefined) return json({ error: "Live voice is unavailable" }, 404);
          try {
            const body = await readJsonObject(req);
            const text = typeof body.text === "string" ? body.text.trim() : "";
            if (text === "") return json({ error: "text is required" }, 400);
            return json(await management.voice.inject(text));
          } catch (error) {
            return json({ error: error instanceof Error ? error.message : String(error) }, 400);
          }
        },
      },

      "/assets/voice-tab.js": async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        return dashboardAssetResponse("./voice-tab.tsx", "Voice tab");
      },

      "/assets/relationships-lab.js": async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        return dashboardAssetResponse("./relationships-lab.tsx", "Relationships");
      },

      "/assets/memories-tab.js": async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        return dashboardAssetResponse("./memories-tab.tsx", "Memories tab");
      },

      "/assets/notebooks-tab.js": async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        return dashboardAssetResponse("./notebooks-tab.tsx", "Notebooks tab");
      },

      "/assets/prompts-tab.js": async (req) => {
        const denied = requireAuth(req);
        if (denied !== null) return denied;
        return dashboardAssetResponse("./prompts-tab.tsx", "Prompts tab");
      },

      "/": {
        GET: (req) => {
          if (!isAuthBypassed(req) && !isDashboardAuthenticated(req)) {
            return Response.redirect("/login", 302);
          }
          return new Response(Bun.file(dashboard.index).stream(), {
            headers: { "content-type": "text/html" },
          });
        },
      },
  };
}
