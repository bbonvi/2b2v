import { createLogger, RequestLog, type LogLevel } from "./logger";
import { requestLogStore } from "./dashboard/store";
import { startDashboard } from "./dashboard/server";
import { loadGlobalConfig, loadGuildConfigs, resolveGuildConfig, validateTrimConfig, validateVpnConfig, validateBashToolConfig } from "./config/loader";
import type { GuildConfig } from "./config/types";
import { createDatabase } from "./db/database";
import { createQdrantClient, ensureCollection, healthCheck } from "./qdrant/client";
import { deletePoint, toPointId } from "./qdrant/adapter";
import { getEmbeddingPipeline, disposePipeline } from "./embeddings/pipeline";
import { createEmbeddingQueue, type EmbeddingQueue } from "./embeddings/queue";
import { createDiscordClient, loginDiscordClient } from "./discord/client";
import { translateInbound, translateOutbound, buildDisplayNameContext, type InboundResolvers, type OutboundResolvers } from "./discord/translation";
import { splitMessage } from "./discord/split-message";
import { EmojiCache, buildEmojiContext, type EmojiEntry } from "./discord/emoji-cache";
import { createSchedulerEngine, type SchedulerEngine } from "./scheduler/engine";
import { handleMessage, type IncomingMessage, type HandlerDeps } from "./agent/handler";
import { TOOL_INSTRUCTIONS } from "./agent/prompt";
import { assembleContext, type AssembledContext } from "./agent/context-assembly";
import type { HistoryMessage } from "./agent/history-types";
import { getHistoryMessages } from "./db/message-repository";
import { processHistory } from "./agent/history-pipeline";
import { formatMemoryTimestamps, formatRelativeAgo } from "./agent/history-dates";
import type { ReplyFallbackDeps } from "./agent/reply-target-fallback";

import type { MessageSender } from "./agent/send-message-tool";
import { createElevenLabsClient, type ElevenLabsClient } from "./tts/client";
import type { TtsResult } from "./tts/types";
import { createMemoryTools } from "./agent/memory-tools";
import { createSearchTool } from "./agent/search-tool";
import { createScheduleTool } from "./agent/schedule-tool";
import { createMemberListTool, type MemberInfo } from "./agent/member-list-tool";
import { createChatHistoryTool, type ChatHistoryMessage } from "./agent/chat-history-tool";
import { createBraveSearchTool } from "./agent/brave-search-tool";
import { createReadChatImagesTool } from "./agent/read-chat-images-tool";
import { createFetchImagesTool } from "./agent/fetch-images-tool";
import { createFetchUrlTool } from "./agent/fetch-url-tool";
import { createStartTypingTool } from "./agent/start-typing-tool";
import { createStartThreadTool } from "./agent/start-thread-tool";
import { getImageById, getImagesByMessageId } from "./db/image-repository";
import { insertThread, updateThreadActivity, markBotParticipating, listThreadsForContext } from "./db/thread-repository";
import { processAndStoreImage, type ImageIngestDeps } from "./db/image-ingest";
import { createBashTool } from "./agent/bash-tool";
import { getSshKeyPaths, ensureSshKeys, createSshConnection, type SshKeyPaths } from "./ssh/client";
import type { Client as SshClient } from "ssh2";
import { listMemories, deleteExpiredMemories, countUserMemoriesByUser } from "./db/memory-repository";
import { listUpcomingForContext, createSchedule, deleteSchedule, listSchedules } from "./db/schedule-repository";
import { registerSlashCommands } from "./commands/registry";
import { createStatusHandler, statusCommandDefinition } from "./commands/status";
import { createScheduleHandler, scheduleCommandDefinition } from "./commands/schedule";
import { createMemoryWipeHandler, memoryWipeCommandDefinition } from "./commands/memory-wipe";
import { vpnCommandDefinition } from "./commands/vpn";
import { createVpnClient, type VpnClient } from "./vpn/api-client";
import { createSessionStore, type SessionStore } from "./vpn/session";
import { handleVpnCommand, handleVpnComponent, type VpnHandlerDeps } from "./vpn/handler";
import { getVpnLocale } from "./vpn/i18n";
import { join } from "path";
import { mkdirSync, existsSync, readFileSync, watch } from "fs";
import type { Database } from "./db/database";
import { AttachmentBuilder, type ChatInputCommandInteraction, type Client, type Guild, type Message, type TextChannel } from "discord.js";

const pkg = await Bun.file(new URL("../package.json", import.meta.url).pathname).json() as { version?: string };
const version: string = pkg.version ?? "0.0.0";

const startTime = Date.now();
const logLevel = (process.env.LOG_LEVEL ?? "info") as LogLevel;
const log = createLogger({ level: logLevel });

log.info("bot starting", {
  version,
  runtime: `bun ${Bun.version}`,
  pid: process.pid,
});

// --- 1. Load global config (throws on missing secrets) ---
let globalConfig = loadGlobalConfig();
validateTrimConfig(globalConfig.defaultTrim);
validateVpnConfig(globalConfig.vpn);
validateBashToolConfig(globalConfig.defaultBashTool);
log.info("config loaded", { model: globalConfig.defaultModel, qdrant: globalConfig.qdrantUrl });

// --- 2. Ensure data directory exists ---
if (!existsSync(globalConfig.dataDir)) {
  mkdirSync(globalConfig.dataDir, { recursive: true });
}

// --- 3. Init SQLite ---
const dbPath = join(globalConfig.dataDir, "bot.db");
const db: Database = createDatabase(dbPath);
log.info("database ready", { path: dbPath });

// --- 4. Init Qdrant ---
const qdrant = createQdrantClient({ url: globalConfig.qdrantUrl });
const qdrantHealthy = await healthCheck(qdrant);
if (!qdrantHealthy) {
  log.error("qdrant health check failed", { url: globalConfig.qdrantUrl });
  process.exit(1);
}
await ensureCollection(qdrant);
log.info("qdrant ready");

// --- 5. Init embedding pipeline ---
const embeddingPipeline = await getEmbeddingPipeline({ cacheDir: globalConfig.modelCacheDir });
log.info("embedding pipeline ready");

// --- 6. Init embedding queue ---
const embeddingQueue: EmbeddingQueue = createEmbeddingQueue(embeddingPipeline, qdrant);

// --- 7. Load guild configs ---
const guildsDir = join("config", "guilds");
const guildConfigs = loadGuildConfigs(guildsDir, globalConfig);
log.info("guild configs loaded", { count: guildConfigs.size });

// --- 8. Load persona ---
function loadPersonaFile(path: string): string {
  try {
    const content = readFileSync(path, "utf-8").trim();
    log.info("persona loaded", { path, length: content.length });
    return content;
  } catch {
    log.warn("persona file not found, using empty persona", { path });
    return "";
  }
}
let persona = loadPersonaFile(globalConfig.personaPath);

// --- 9. Emoji cache ---
const emojiCache = new EmojiCache();
const EMOJI_TTL_MS = 10 * 60 * 1000; // 10 minutes

// --- 9b. TTS client (optional) ---
let ttsClient: ElevenLabsClient | undefined;
if (globalConfig.elevenLabsApiKey !== undefined && globalConfig.elevenLabsApiKey !== "") {
  ttsClient = createElevenLabsClient({ apiKey: globalConfig.elevenLabsApiKey });
  log.info("tts client ready");
}

// --- 9c. VPN client and session store ---
const vpnConfig = globalConfig.vpn;
const vpnEnabled = vpnConfig !== undefined;
const vpnClient: VpnClient | null = vpnEnabled ? createVpnClient(vpnConfig.apiUrl) : null;
const vpnSessionStore: SessionStore = createSessionStore();

if (vpnEnabled) {
  log.info("vpn client ready", { apiUrl: vpnConfig.apiUrl });
} else {
  log.info("vpn disabled");
}

// Periodic VPN session cleanup (every 5 minutes)
const VPN_SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const vpnSessionCleanupTimer = setInterval(() => {
  vpnSessionStore.cleanExpired();
}, VPN_SESSION_CLEANUP_INTERVAL_MS);

// --- 9d. SSH key setup for bash tool ---
// SSH_KEYS_LOCAL: bot's private keys (never shared with bash-vm)
// SSH_KEYS_SHARED: only authorized_keys (mounted read-only by bash-vm)
const sshKeysLocal = process.env.SSH_KEYS_LOCAL;
const sshKeysShared = process.env.SSH_KEYS_SHARED;
let sshKeyPaths: SshKeyPaths | undefined;
let sshClient: SshClient | undefined;

// Create SSH keys when both paths are set (compose environment with bash-vm).
// This ensures bash-vm can start (it waits for authorized_keys in shared dir).
// The tool itself is only enabled when bashTool.enabled is true.
if (sshKeysLocal !== undefined && sshKeysShared !== undefined) {
  sshKeyPaths = getSshKeyPaths(sshKeysLocal, sshKeysShared);
  try {
    ensureSshKeys(sshKeyPaths);
    log.info("ssh keys ready", { local: sshKeysLocal, shared: sshKeysShared });
  } catch (err) {
    log.error("ssh key setup failed", { error: err instanceof Error ? err.message : String(err) });
    sshKeyPaths = undefined;
  }
}

/** Get or create SSH client connection to bash-vm. */
async function getSshClient(): Promise<SshClient> {
  if (sshKeyPaths === undefined) {
    throw new Error("SSH keys not configured");
  }
  if (globalConfig.defaultBashTool === undefined) {
    throw new Error("Bash tool not configured");
  }
  if (sshClient !== undefined) {
    return sshClient;
  }
  const cfg = globalConfig.defaultBashTool.ssh;
  sshClient = await createSshConnection(
    { host: cfg.host, port: cfg.port, username: cfg.user },
    sshKeyPaths,
  );
  sshClient.on("close", () => {
    sshClient = undefined;
  });
  sshClient.on("error", () => {
    sshClient = undefined;
  });
  return sshClient;
}

// --- 10. Guild config resolver ---
function getGuildConfig(guildId: string): GuildConfig {
  const existing = guildConfigs.get(guildId);
  if (existing !== undefined) return existing;
  // Auto-create default config for unknown guilds
  const resolved = resolveGuildConfig(globalConfig, { guildId, slug: "" });
  guildConfigs.set(guildId, resolved);
  return resolved;
}

// --- 12. Init scheduler ---
const scheduler: SchedulerEngine = createSchedulerEngine({
  db,
  onFire: (event) => {
    const { schedule } = event;
    log.info("schedule fired", { scheduleId: schedule.id, guildId: schedule.guildId });
    const channel = client.channels.cache.get(schedule.channelId);
    if (channel !== undefined && "send" in channel) {
      const scheduleChunks = splitMessage(schedule.messageContent);
      void (async () => {
        for (const chunk of scheduleChunks) {
          const sent = await (channel as TextChannel).send(chunk);
          const ts = Date.now();
          db.raw
            .prepare(
              `INSERT OR IGNORE INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(sent.id, schedule.guildId, schedule.channelId, client.user?.id ?? "", client.user?.username ?? "bot", chunk, chunk, 1, ts, null);

          void embeddingQueue.enqueue({
            id: sent.id,
            text: chunk,
            target: "message",
            metadata: {
              guild_id: schedule.guildId,
              channel_id: schedule.channelId,
              user_id: client.user?.id ?? "",
              created_at: ts,
            },
          }).catch((err: unknown) => {
            log.error("scheduled message embedding enqueue failed", {
              scheduleId: schedule.id,
              messageId: sent.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      })().catch((err: unknown) => {
        log.error("failed to send scheduled message", {
          scheduleId: schedule.id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  },
  log,
});
scheduler.start();
log.info("scheduler started", { jobs: scheduler.activeCount() });

// --- Periodic expired memory cleanup (hourly) ---
const MEMORY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const memoryCleanupTimer = setInterval(() => {
  const deleted = deleteExpiredMemories(db);
  if (deleted > 0) {
    log.info("expired memories cleaned", { deleted });
  }
}, MEMORY_CLEANUP_INTERVAL_MS);

// --- 13. Create and login Discord client ---
const client: Client = createDiscordClient(globalConfig, log);
await loginDiscordClient(client, globalConfig.discordToken);

// --- 14. Register slash commands ---
const botUser = client.user;
if (botUser !== null) {
  try {
    const commandCount = await registerSlashCommands({
      token: globalConfig.discordToken,
      clientId: botUser.id,
      commands: [
        statusCommandDefinition.toJSON(),
        scheduleCommandDefinition.toJSON(),
        memoryWipeCommandDefinition.toJSON(),
        vpnCommandDefinition.toJSON(),
      ],
    });
    log.info("slash commands registered", { count: commandCount });
  } catch (err) {
    log.error("failed to register slash commands", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// --- 15. Command handlers ---
const commandHandlers = new Map<string, (interaction: ChatInputCommandInteraction) => Promise<void>>();

function setupCommandHandlers(guildId: string): void {
  const config = getGuildConfig(guildId);

  commandHandlers.set("status", createStatusHandler({
    getStats: () => ({
      uptimeMs: Date.now() - startTime,
      guildCount: client.guilds.cache.size,
      messageCount: (db.raw.prepare("SELECT COUNT(*) as c FROM messages").get() as { c: number }).c,
      memoryCount: (db.raw.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c,
      scheduleCount: (db.raw.prepare("SELECT COUNT(*) as c FROM schedules WHERE enabled = 1").get() as { c: number }).c,
    }),
    adminUserIds: config.adminUserIds,
  }));

  commandHandlers.set("schedule", createScheduleHandler({
    listSchedules: (filter) => listSchedules(db, filter),
    createSchedule: (input) => createSchedule(db, input),
    deleteSchedule: (id) => deleteSchedule(db, id),
    onScheduleCreated: (id) => scheduler.addSchedule(id),
    onScheduleRemoved: (id) => scheduler.removeSchedule(id),
    adminUserIds: config.adminUserIds,
  }));

  commandHandlers.set("memory-wipe", createMemoryWipeHandler({
    wipeGuild: (gId) => {
      const memoriesDeleted = (db.raw.prepare("DELETE FROM memories WHERE guild_id = ?").run(gId) as { changes: number }).changes;
      const messagesDeleted = (db.raw.prepare("DELETE FROM messages WHERE guild_id = ?").run(gId) as { changes: number }).changes;

      return Promise.resolve({ memoriesDeleted, messagesDeleted });
    },
    adminUserIds: config.adminUserIds,
  }));
}

// --- 16. interactionCreate handler ---
client.on("interactionCreate", (interaction) => void (async () => {
  // Handle button/select interactions (VPN UI)
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    const vpnDeps: VpnHandlerDeps = {
      client: vpnClient,
      sessionStore: vpnSessionStore,
      vpnPeer: vpnConfig?.vpnPeer ?? "",
      log: log.child({ component: "vpn" }),
      locale: getVpnLocale(globalConfig.uiLang),
      enabled: vpnEnabled,
    };
    try {
      const handled = await handleVpnComponent(interaction, vpnDeps);
      if (!handled) {
        // Unknown component interaction
        log.warn("unknown component interaction", { customId: interaction.customId });
      }
    } catch (err) {
      log.error("component interaction error", {
        customId: interaction.customId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // Handle slash commands
  if (!interaction.isChatInputCommand()) return;

  // Special handling for /vpn (open to all users, no guild config needed)
  if (interaction.commandName === "vpn") {
    const vpnDeps: VpnHandlerDeps = {
      client: vpnClient,
      sessionStore: vpnSessionStore,
      vpnPeer: vpnConfig?.vpnPeer ?? "",
      log: log.child({ component: "vpn" }),
      locale: getVpnLocale(globalConfig.uiLang),
      enabled: vpnEnabled,
    };
    try {
      await handleVpnCommand(interaction, vpnDeps);
    } catch (err) {
      log.error("vpn command error", {
        guildId: interaction.guildId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "Произошла ошибка.", ephemeral: true }).catch(() => {});
      }
    }
    return;
  }

  // Admin commands require guild
  if (interaction.guildId === null) return;

  // Rebuild handlers with fresh guild config each time
  setupCommandHandlers(interaction.guildId);

  const handler = commandHandlers.get(interaction.commandName);
  if (handler !== undefined) {
    try {
      await handler(interaction);
    } catch (err) {
      log.error("command handler error", {
        command: interaction.commandName,
        guildId: interaction.guildId,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: "An error occurred.", ephemeral: true }).catch(() => {});
      }
    }
  }
})());

// --- 17. Build resolvers from a Discord guild ---
function buildInboundResolvers(guild: Guild): InboundResolvers {
  return {
    user: (id) => {
      const member = guild.members.cache.get(id);
      if (member === undefined) return undefined;
      return { username: member.user.username, displayName: member.displayName };
    },
    channel: (id) => {
      const ch = guild.channels.cache.get(id);
      return ch !== undefined ? ch.name : undefined;
    },
    role: (id) => {
      const role = guild.roles.cache.get(id);
      return role !== undefined ? role.name : undefined;
    },
  };
}

function buildOutboundResolvers(guild: Guild): OutboundResolvers {
  return {
    user: (username) => {
      const member = guild.members.cache.find((m) => m.user.username === username);
      return member !== undefined ? member.id : undefined;
    },
    channel: (name) => {
      const ch = guild.channels.cache.find((c) => c.name === name);
      return ch !== undefined ? ch.id : undefined;
    },
    emoji: (name) => emojiCache.lookup(guild.id, name),
  };
}

// --- 18. Refresh emoji cache for a guild ---
function refreshEmojiCache(guild: Guild): void {
  if (!emojiCache.isStale(guild.id, EMOJI_TTL_MS)) return;
  const emojis: EmojiEntry[] = guild.emojis.cache.map((e) => ({
    name: e.name,
    id: e.id,
    animated: e.animated,
  }));
  emojiCache.set(guild.id, emojis);
}

// --- 19. Build assembled context for a guild+channel ---
async function buildContext(
  guildId: string,
  channelId: string,
  guild: Guild,
  guildConfig: GuildConfig,
  userMessage: string,
  latestUserMessage: HistoryMessage,
  replyFallbackDeps: ReplyFallbackDeps,
): Promise<AssembledContext> {
  // Chat history via the full processing pipeline
  const historyMessages = getHistoryMessages(db, channelId, guildConfig.trim.trimTrigger);
  const historyWithoutLatest = historyMessages.filter((m) => m.id !== latestUserMessage.id);
  const { olderText, newerText } = await processHistory(
    historyWithoutLatest,
    latestUserMessage,
    {
      trim: guildConfig.trim,
      mergeMessageGapSeconds: guildConfig.mergeMessageGapSeconds,
      timezone: guildConfig.timezone,
      imageCaptioningEnabled: guildConfig.imageCaptioningEnabled,
      replyQuoteChars: guildConfig.trim.replyQuoteChars,
    },
    replyFallbackDeps,
  );

  // Journal summaries — sorted by updatedAt ascending, then ID
  const botUserId = client.user?.id ?? "";
  const journals = listMemories(db, { scope: "journal", guildId, userId: botUserId })
    .filter((m) => m.shortDescription !== "")
    .sort((a, b) => {
      const ud = a.updatedAt - b.updatedAt;
      return ud !== 0 ? ud : a.id - b.id;
    });
  const journalSummaries = journals
    .map((m) => `- [${m.id}] ${formatMemoryTimestamps(m.createdAt, m.updatedAt)} ${m.shortDescription}`)
    .join("\n");

  // Upcoming schedules — one-off by runAt then ID; cron by expression then ID; one-off first
  const upcoming = listUpcomingForContext(db, guildId)
    .sort((a, b) => {
      const typeOrder = (s: typeof a) => s.type === "cron" ? 1 : 0;
      const td = typeOrder(a) - typeOrder(b);
      if (td !== 0) return td;
      if (a.type === "cron" && b.type === "cron") {
        const ec = (a.cronExpression ?? "").localeCompare(b.cronExpression ?? "");
        return ec !== 0 ? ec : a.id.localeCompare(b.id);
      }
      const rd = (a.runAt ?? 0) - (b.runAt ?? 0);
      return rd !== 0 ? rd : a.id.localeCompare(b.id);
    });
  const upcomingSchedules = upcoming.map((s) => {
    if (s.type === "cron") return `- [cron] ${s.cronExpression ?? "?"}: ${s.messageContent}`;
    const runDate = s.runAt !== null ? new Date(s.runAt).toISOString() : "?";
    return `- [one-off at ${runDate}]: ${s.messageContent}`;
  }).join("\n");

  // Emoji context — sorted by name (case-insensitive), then by ID
  refreshEmojiCache(guild);
  const emojis = [...(emojiCache.get(guildId) ?? [])]
    .sort((a, b) => {
      const nc = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      return nc !== 0 ? nc : a.id.localeCompare(b.id);
    });
  const emojiContext = buildEmojiContext(emojis);

  // Display name context — sorted by username (case-insensitive), then by member ID
  const members = [...guild.members.cache.values()]
    .sort((a, b) => {
      const uc = a.user.username.toLowerCase().localeCompare(b.user.username.toLowerCase());
      return uc !== 0 ? uc : a.id.localeCompare(b.id);
    })
    .map((m) => ({ userId: m.user.id, username: m.user.username, displayName: m.displayName }));
  const memoryCounts = countUserMemoriesByUser(db, guildId);
  const displayNameContext = buildDisplayNameContext(members, memoryCounts);

  // Current context metadata
  const currentContext = `Guild: ${guildId} | Channel: ${channelId}\nDate/Time: ${new Date().toISOString()}`;

  // Thread list for parent channels (bot-participating threads only)
  const threads = listThreadsForContext(db, channelId);
  const threadsInChat = threads
    .map((t) => `- "${t.threadName}" (thread_id: ${t.threadId}) — ${t.messageCount} msgs, ${formatRelativeAgo(t.lastActivityAt)}`)
    .join("\n");

  return assembleContext({
    persona,
    toolInstructions: TOOL_INSTRUCTIONS,
    instructions: guildConfig.instructions,
    emojis: emojiContext,
    members: displayNameContext,
    journalSummaries,
    upcomingSchedules,
    threadsInChat,
    olderHistory: olderText,
    newerHistory: newerText,
    currentContext,
    lateInstruction: "IMPORTANT: Always call `start_typing` immediately before each `send_message`.",
    userMessage,
  });
}

// --- 20. Build agent tools for a message context ---
function buildAgentTools(guildId: string, channelId: string, guildConfig: GuildConfig, guild: Guild) {
  // Resolve username to userId using guild member cache
  const resolveUsername = (username: string): string | undefined => {
    const member = guild.members.cache.find((m) => m.user.username === username);
    return member?.user.id;
  };

  const memoryTools = createMemoryTools({
    db,
    guildId,
    botUserId: client.user?.id ?? "",
    resolveUsername,
    onMemoryChanged: (memoryId, text) => {
      void embeddingQueue.enqueue({
        id: String(memoryId),
        text,
        target: "memory",
        metadata: { guild_id: guildId },
      }).catch((err: unknown) => {
        log.error("memory embedding enqueue failed", {
          memoryId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    onMemoryDeleted: (memoryId) => {
      void deletePoint(qdrant, toPointId(String(memoryId))).catch((err: unknown) => {
        log.error("memory qdrant delete failed", {
          memoryId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
  });

  const searchTool = createSearchTool({
    db,
    qdrant,
    guildId,
    embed: embeddingPipeline,
    resolveUsername,
    fetchMessage: async (chId, msgId) => {
      const channel = guild.channels.cache.get(chId);
      if (channel === undefined || !("messages" in channel)) return null;
      try {
        const msg = await (channel as TextChannel).messages.fetch(msgId);
        return {
          attachments: [...msg.attachments.values()].map((a) => ({
            name: a.name,
            contentType: a.contentType,
            size: a.size,
          })),
        };
      } catch {
        return null;
      }
    },
  });

  const scheduleTool = createScheduleTool({
    db,
    guildId,
    channelId,
    timezone: guildConfig.timezone,
    onScheduleCreated: (id) => scheduler.addSchedule(id),
  });

  const memberListTool = createMemberListTool({
    guildId,
    fetchMembers: async (_gId, onlineOnly) => {
      const members: MemberInfo[] = [];
      // Ensure members are fetched
      try {
        await guild.members.fetch();
      } catch {
        // May not have permission
      }
      for (const [, member] of guild.members.cache) {
        const status = member.presence?.status ?? "offline";
        if (onlineOnly && status === "offline") continue;
        members.push({
          userId: member.id,
          username: member.user.username,
          displayName: member.displayName,
          status: status as "online" | "idle" | "dnd" | "offline",
          isBot: member.user.bot,
        });
      }
      return members;
    },
  });

  const chatHistoryTool = createChatHistoryTool({
    guildId,
    fetchMessages: async (chatId, limit) => {
      const channel = guild.channels.cache.get(chatId);
      if (channel === undefined || !("messages" in channel)) return [];
      const textChannel = channel as TextChannel;
      const msgs = await textChannel.messages.fetch({ limit });
      const result: ChatHistoryMessage[] = [];
      for (const [, msg] of msgs) {
        result.push({
          id: msg.id,
          authorUsername: msg.author.username,
          content: msg.content,
          createdAt: msg.createdTimestamp,
        });
      }
      return result;
    },
  });

  const readChatImagesTool = createReadChatImagesTool({
    imageReadMaxPerCall: guildConfig.imageReadMaxPerCall,
    getImageById: (id: number) => getImageById(db, id),
    readFile: (path: string) => {
      try {
        return Buffer.from(readFileSync(path));
      } catch {
        return null;
      }
    },
  });

  const fetchImagesTool = createFetchImagesTool({
    maxImagesPerCall: 5,
    maxDimension: guildConfig.imageMaxDimension,
  });

  const fetchUrlTool = createFetchUrlTool();

  const tools = [...memoryTools, searchTool, scheduleTool, memberListTool, chatHistoryTool, readChatImagesTool, fetchImagesTool, fetchUrlTool];

  // Brave search if API key configured
  if (globalConfig.braveApiKey !== undefined && globalConfig.braveApiKey !== "") {
    tools.push(createBraveSearchTool({ apiKey: globalConfig.braveApiKey }));
  }

  // Bash tool if enabled (global + guild)
  if (guildConfig.bashTool?.enabled === true && sshKeyPaths !== undefined) {
    tools.push(createBashTool({
      getClient: getSshClient,
      config: guildConfig.bashTool,
    }));
  }

  return tools;
}

// --- 21. messageCreate handler ---
client.on("messageCreate", (message: Message) => void (async () => {
  try {
    // Ignore bots (including self)
    if (message.author.bot) return;
    // Ignore DMs
    if (message.guild === null || message.guildId === null) return;

    const guild = message.guild;
    const guildId = message.guildId;
    const channelId = message.channelId;
    requestLogStore.incrementActive();
    const guildConfig = getGuildConfig(guildId);

    // Build inbound resolvers and translate
    const inboundResolvers = buildInboundResolvers(guild);
    const translatedContent = translateInbound(message.content, inboundResolvers);

    // Store message in SQLite
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT OR IGNORE INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(message.id, guildId, channelId, message.author.id, message.author.username, message.content, translatedContent, 0, now, message.reference?.messageId ?? null);

    // Enqueue for embedding
    void embeddingQueue.enqueue({
      id: message.id,
      text: translatedContent,
      target: "message",
      metadata: {
        guild_id: guildId,
        channel_id: channelId,
        user_id: message.author.id,
        created_at: now,
      },
    }).catch((err: unknown) => {
      log.error("embedding enqueue failed", {
        messageId: message.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Update thread activity if message is in a thread
    if (message.channel.isThread()) {
      updateThreadActivity(db, channelId, {
        lastActivityAt: now,
        lastMessageId: message.id,
      });
    }

    // Process and persist images (no inline payloads — LLM uses read_images tool)
    const ingestDeps: ImageIngestDeps = {
      db,
      attachmentsDir: guildConfig.attachmentsDir,
      maxDimension: guildConfig.imageMaxDimension,
      fetchFn: fetch,
    };
    const imageIngestPromises: Promise<void>[] = [];
    for (const attachment of message.attachments.values()) {
      const contentType = attachment.contentType ?? "";
      if (!contentType.startsWith("image/")) continue;
      imageIngestPromises.push(
        processAndStoreImage(
          ingestDeps,
          { url: attachment.url, mimeType: contentType, messageId: message.id, guildId, channelId },
        ).then(() => undefined).catch((err: unknown) => {
          log.warn("image ingest failed", {
            attachmentId: attachment.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      );
    }

    // Extract images from embeds (Tenor/Giphy GIFs appear here, not in attachments)
    for (const embed of message.embeds) {
      const embedUrl = embed.image?.url ?? embed.thumbnail?.url;
      if (embedUrl === undefined) continue;

      // Infer MIME type from URL; default to image/png
      const mimeGuess = embedUrl.includes(".gif") ? "image/gif"
                      : embedUrl.includes(".webp") ? "image/webp"
                      : "image/png";

      imageIngestPromises.push(
        processAndStoreImage(ingestDeps, {
          url: embedUrl,
          mimeType: mimeGuess,
          messageId: message.id,
          guildId,
          channelId,
        }).then(() => undefined).catch((err: unknown) => {
          log.warn("embed image ingest failed", {
            embedUrl,
            error: err instanceof Error ? err.message : String(err),
          });
        }),
      );
    }

    await Promise.allSettled(imageIngestPromises);

    // Build outbound resolvers for the sender
    const outboundResolvers = buildOutboundResolvers(guild);

    function storeBotMessage(sentId: string, targetChannelId: string, rawContent: string, plainContent: string): void {
      const ts = Date.now();
      db.raw
        .prepare(
          `INSERT OR IGNORE INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at, reply_to_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(sentId, guildId, targetChannelId, client.user?.id ?? "", client.user?.username ?? "bot", rawContent, plainContent, 1, ts, null);

      void embeddingQueue.enqueue({
        id: sentId,
        text: plainContent,
        target: "message",
        metadata: {
          guild_id: guildId,
          channel_id: targetChannelId,
          user_id: client.user?.id ?? "",
          created_at: ts,
        },
      }).catch((err: unknown) => {
        log.error("bot message embedding enqueue failed", {
          messageId: sentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Build message sender with chat_id routing
    const currentChannelObj = message.channel as TextChannel;

    /** Resolve target channel from chatId or fall back to current channel. */
    function resolveTargetChannel(chatId: string | undefined): TextChannel {
      if (chatId === undefined) {
        return currentChannelObj;
      }
      const resolved = guild.channels.cache.get(chatId);
      if (resolved === undefined) {
        throw new Error(`Invalid chat_id: channel "${chatId}" not found`);
      }
      if (!("send" in resolved)) {
        throw new Error(`Invalid chat_id: channel "${chatId}" is not a text channel`);
      }
      return resolved as TextChannel;
    }

    const sender: MessageSender = async (text, reply, chatId, voice, _signal) => {
      const targetChannel = resolveTargetChannel(chatId);
      const targetChannelId = targetChannel.id;

      const sinceTypingMs = Date.now() - lastTypingAt;
      if (sinceTypingMs >= 0 && sinceTypingMs < 200) {
        await new Promise((resolve) => setTimeout(resolve, 200 - sinceTypingMs));
      }

      // Voice message path: send audio attachment
      if (voice !== undefined) {
        const attachment = new AttachmentBuilder(voice.buffer, { name: voice.filename });
        const sent = reply
          ? await message.reply({ files: [attachment] })
          : await targetChannel.send({ files: [attachment] });
        storeBotMessage(sent.id, targetChannelId, "[Voice Message]", text);
        // Mark bot participating if sending to a thread
        if (targetChannel.isThread()) {
          markBotParticipating(db, targetChannelId);
        }
        return { sentMessageId: sent.id };
      }

      // Text message path
      const translated = translateOutbound(text, outboundResolvers);
      const chunks = splitMessage(translated);
      let firstId = "";
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i] as string;
        const sent = (reply && i === 0)
          ? await message.reply(chunk)
          : await targetChannel.send(chunk);
        if (i === 0) firstId = sent.id;
        storeBotMessage(sent.id, targetChannelId, chunk, i === 0 ? text : chunk);
      }
      // Mark bot participating if sending to a thread
      if (targetChannel.isThread()) {
        markBotParticipating(db, targetChannelId);
      }
      return { sentMessageId: firstId };
    };

    // Build latest user message as HistoryMessage for pipeline
    const ingestedImages = getImagesByMessageId(db, message.id);
    const latestUserMessage: HistoryMessage = {
      id: message.id,
      author: message.author.username,
      authorId: message.author.id,
      content: translatedContent,
      isBot: false,
      timestamp: now,
      replyToId: message.reference?.messageId ?? null,
      imageIds: ingestedImages.map((img) => img.id),
      captions: ingestedImages.map((img) => img.caption).filter((c): c is string => c !== null),
      hasEmbeds: message.embeds.length > 0,
    };

    // Build reply fallback deps for fetching missing reply targets
    const replyFallbackDeps: ReplyFallbackDeps = {
      db,
      guildId,
      channelId,
      fetchDiscordMessage: async (chId, msgId) => {
        const ch = guild.channels.cache.get(chId);
        if (ch === undefined || !("messages" in ch)) return null;
        try {
          const fetched = await (ch as TextChannel).messages.fetch(msgId);
          return {
            id: fetched.id,
            authorId: fetched.author.id,
            authorUsername: fetched.author.username,
            content: fetched.content,
            timestamp: fetched.createdTimestamp,
            isBot: fetched.author.bot,
            replyToId: fetched.reference?.messageId ?? null,
            attachments: [...fetched.attachments.values()].map((a) => ({
              url: a.url,
              contentType: a.contentType,
            })),
          };
        } catch {
          return null;
        }
      },
      enqueueEmbedding: async (id, text, metadata) => {
        await embeddingQueue.enqueue({
          id,
          text,
          target: "message",
          metadata,
        });
      },
      processImage: async (url, contentType, messageId) => {
        await processAndStoreImage(ingestDeps, {
          url,
          mimeType: contentType,
          messageId,
          guildId,
          channelId,
        });
      },
    };

    // Build assembled context
    const context = await buildContext(guildId, channelId, guild, guildConfig, translatedContent, latestUserMessage, replyFallbackDeps);

    let lastTypingAt = 0;
    const sendTypingNow = (): void => {
      lastTypingAt = Date.now();
      void currentChannelObj.sendTyping().catch(() => {});
    };

    // Build agent tools (including start_typing and start_thread wired to the message)
    const startTypingTool = createStartTypingTool(sendTypingNow);
    const startThreadTool = createStartThreadTool({
      guildId,
      createThread: async (name: string) => {
        const thread = await message.startThread({ name });
        return {
          threadId: thread.id,
          threadName: thread.name,
          parentChatId: channelId,
          starterMessageId: message.id,
        };
      },
      persistThread: (input) => insertThread(db, input),
    });
    const extraTools = [...buildAgentTools(guildId, channelId, guildConfig, guild), startTypingTool, startThreadTool];

    const TYPING_INTERVAL_MS = 8_000;
    const TYPING_MAX_MS = 30_000;
    let typingTimer: ReturnType<typeof setInterval> | null = null;
    let typingTimeout: ReturnType<typeof setTimeout> | null = null;
    const startTypingLoop = (): void => {
      if (typingTimer !== null) return;
      sendTypingNow();
      typingTimer = setInterval(() => {
        sendTypingNow();
      }, TYPING_INTERVAL_MS);
      typingTimeout = setTimeout(() => {
        stopTypingLoop();
      }, TYPING_MAX_MS);
    };
    const stopTypingLoop = (): void => {
      if (typingTimer !== null) {
        clearInterval(typingTimer);
        typingTimer = null;
      }
      if (typingTimeout !== null) {
        clearTimeout(typingTimeout);
        typingTimeout = null;
      }
    };

    // Build incoming message
    const incoming: IncomingMessage = {
      content: message.content,
      authorId: message.author.id,
      authorUsername: message.author.username,
      botUserId: client.user?.id ?? "",
      mentionedUserIds: [...message.mentions.users.keys()],
      translatedContent,
    };

    // Build request log accumulator
    const requestLog = new RequestLog(guildId, channelId);
    requestLog.setAuthor(message.author.username);

    // Build TTS dependencies
    const ttsEnabled = ttsClient !== undefined && guildConfig.tts?.enabled === true;
    const generateSpeech = ttsEnabled && ttsClient !== undefined && guildConfig.tts !== undefined
      ? async (text: string, voiceType: string): Promise<TtsResult> => {
          const preset = voiceType === "whisper"
            ? guildConfig.tts?.voices.whisper
            : guildConfig.tts?.voices.normal;
          if (preset === undefined) {
            return { ok: false, error: `Voice type "${voiceType}" not configured` };
          }
          return ttsClient.generate({
            text,
            voiceId: preset.voiceId,
            model: preset.model,
            voiceSettings: {
              stability: preset.stability,
              similarityBoost: preset.similarityBoost,
              speed: preset.speed,
            },
          });
        }
      : undefined;

    // Build handler deps
    const deps: HandlerDeps = {
      globalConfig,
      guildConfig,
      context,
      sender,
      extraTools,
      log: log.child({ guildId, channelId, requestId: requestLog.requestId }),
      onTriggered: startTypingLoop,
      onAssistantResponseStart: stopTypingLoop,
      onAgentEnd: stopTypingLoop,
      requestLog,
      ttsEnabled,
      ttsConfig: guildConfig.tts,
      generateSpeech,
    };

    // Run the handler
    let result;
    try {
      result = await handleMessage(incoming, deps);
    } catch (err) {
      requestLog.setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      stopTypingLoop();
      if (result !== undefined) {
        requestLog.setTrigger(result.triggerResult);
        requestLog.setAgentRan(result.agentRan);
      }
      requestLog.emit(log);
    }
  } catch (err) {
    log.error("messageCreate handler error", {
      messageId: message.id,
      guildId: message.guildId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Push minimal error entry for hard failures that bypass RequestLog.emit
    if (message.guildId !== null) {
      requestLogStore.push({
        requestId: crypto.randomUUID(),
        guildId: message.guildId,
        channelId: message.channelId,
        authorUsername: message.author.username,
        trigger: null,
        agentRan: false,
        tools: [],
        llmCalls: [],
        totalDurationMs: 0,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    }
  } finally {
    // Decrement only if we incremented (i.e. passed the early returns)
    if (message.guild !== null && message.guildId !== null && !message.author.bot) {
      requestLogStore.decrementActive();
    }
  }
})());

// --- Hot-reload config watcher ---
const CONFIG_RELOAD_DEBOUNCE_MS = 500;
let reloadTimer: ReturnType<typeof setTimeout> | null = null;

function reloadConfigs(): void {
  try {
    const newGlobal = loadGlobalConfig(
      process.env as Record<string, string | undefined>,
    );
    validateTrimConfig(newGlobal.defaultTrim);
    globalConfig = newGlobal;
    persona = loadPersonaFile(globalConfig.personaPath);

    // Reload guild configs — clear and rebuild
    const newGuilds = loadGuildConfigs(guildsDir, globalConfig);
    guildConfigs.clear();
    for (const [id, cfg] of newGuilds) {
      guildConfigs.set(id, cfg);
    }

    log.info("config hot-reloaded", { model: globalConfig.defaultModel, guilds: guildConfigs.size });
  } catch (err) {
    log.error("config hot-reload failed, keeping previous config", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

if (existsSync("config")) {
  const watcher = watch("config", { recursive: true }, (_event, _filename) => {
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reloadConfigs, CONFIG_RELOAD_DEBOUNCE_MS);
  });

  // Prevent watcher from keeping the process alive during shutdown
  watcher.unref();
  log.info("config hot-reload watcher started");
}

// --- Health check summary ---
log.info("health check passed — all systems ready", {
  uptimeMs: Date.now() - startTime,
  guilds: guildConfigs.size,
  schedulerJobs: scheduler.activeCount(),
});

// --- Start dashboard ---
const dashboardPassword = process.env.DASHBOARD_PASSWORD;
const bypassDashboardAuth = process.env.UNSAFELY_BYPASS_DASHBOARD_AUTH === "true";
if (bypassDashboardAuth) {
  startDashboard({ port: 3000, password: "", bypassAuth: true, log });
  log.warn("dashboard started with auth bypass — do not use in production");
} else if (dashboardPassword !== undefined && dashboardPassword !== "") {
  startDashboard({ port: 3000, password: dashboardPassword, log });
} else {
  log.info("dashboard disabled (DASHBOARD_PASSWORD not set)");
}

// --- Graceful shutdown ---
async function shutdown(signal: string): Promise<void> {
  log.info("shutting down", { signal });

  clearInterval(memoryCleanupTimer);
  clearInterval(vpnSessionCleanupTimer);
  scheduler.stop();
  if (sshClient !== undefined) {
    sshClient.end();
  }
  await client.destroy();
  await embeddingQueue.shutdown();
  await disposePipeline();
  db.close();

  log.info("shutdown complete");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

export { db, qdrant, embeddingQueue, guildConfigs, globalConfig, persona, scheduler, client };
