import { createLogger, type LogLevel } from "./logger";
import { loadGlobalConfig, loadGuildConfigs, resolveGuildConfig, saveGuildConfig } from "./config/loader";
import type { GuildConfig } from "./config/types";
import { createDatabase } from "./db/database";
import { createQdrantClient, ensureCollection, healthCheck } from "./qdrant/client";
import { deletePoint, toPointId } from "./qdrant/adapter";
import { getEmbeddingPipeline, disposePipeline } from "./embeddings/pipeline";
import { createEmbeddingQueue, type EmbeddingQueue } from "./embeddings/queue";
import { createDiscordClient, loginDiscordClient } from "./discord/client";
import { translateInbound, translateOutbound, buildDisplayNameContext, type InboundResolvers, type OutboundResolvers } from "./discord/translation";
import { EmojiCache, buildEmojiContext, type EmojiEntry } from "./discord/emoji-cache";
import { createSchedulerEngine, type SchedulerEngine } from "./scheduler/engine";
import { handleMessage, type IncomingMessage, type HandlerDeps } from "./agent/handler";
import type { ChatMessage, PromptContext } from "./agent/prompt";
import { trimChatHistory } from "./agent/context-trimming";
import { createMultiMessageSender, type ChannelActions } from "./agent/multi-message";
import { createMemoryTools } from "./agent/memory-tools";
import { createSearchTool } from "./agent/search-tool";
import { createScheduleTool } from "./agent/schedule-tool";
import { createMemberListTool, type MemberInfo } from "./agent/member-list-tool";
import { createChannelHistoryTool, type ChannelMessage } from "./agent/channel-history-tool";
import { createBraveSearchTool } from "./agent/brave-search-tool";
import { resizeImageToContent } from "./agent/vision";
import { listMemories, deleteExpiredMemories } from "./db/memory-repository";
import { listUpcomingForContext, createSchedule, deleteSchedule, listSchedules } from "./db/schedule-repository";
import { registerSlashCommands } from "./commands/registry";
import { createStatusHandler, statusCommandDefinition } from "./commands/status";
import { createConfigHandler, configCommandDefinition } from "./commands/config";
import { createScheduleHandler, scheduleCommandDefinition } from "./commands/schedule";
import { createMemoryWipeHandler, memoryWipeCommandDefinition } from "./commands/memory-wipe";
import { join } from "path";
import { mkdirSync, existsSync, readFileSync } from "fs";
import type { Database } from "./db/database";
import type { ChatInputCommandInteraction, Client, Guild, Message, TextChannel } from "discord.js";

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
const globalConfig = loadGlobalConfig();
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
let persona = "";
try {
  persona = readFileSync(globalConfig.personaPath, "utf-8").trim();
  log.info("persona loaded", { path: globalConfig.personaPath, length: persona.length });
} catch {
  log.warn("persona file not found, using empty persona", { path: globalConfig.personaPath });
}

// --- 9. Emoji cache ---
const emojiCache = new EmojiCache();
const EMOJI_TTL_MS = 10 * 60 * 1000; // 10 minutes

// --- 10. Chat history per channel (in-memory ring buffer for context) ---
const chatHistories = new Map<string, ChatMessage[]>();

function getChatHistory(channelId: string): ChatMessage[] {
  let history = chatHistories.get(channelId);
  if (history === undefined) {
    history = [];
    chatHistories.set(channelId, history);
  }
  return history;
}

// --- 11. Guild config resolver ---
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
      void (channel as TextChannel).send(schedule.messageContent).catch((err: unknown) => {
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
        configCommandDefinition.toJSON(),
        scheduleCommandDefinition.toJSON(),
        memoryWipeCommandDefinition.toJSON(),
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

  commandHandlers.set("config", createConfigHandler({
    getGuildConfig,
    updateGuildConfig: (gId, updated) => {
      guildConfigs.set(gId, updated);
      const slug = guildConfigs.get(gId)?.slug ?? "";
      const filePath = join(guildsDir, `${gId}-${slug}.yaml`);
      saveGuildConfig(filePath, updated);
    },
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
      // Clear channel histories for this guild
      for (const [key] of chatHistories) {
        chatHistories.delete(key);
      }
      return Promise.resolve({ memoriesDeleted, messagesDeleted });
    },
    adminUserIds: config.adminUserIds,
  }));
}

// --- 16. interactionCreate handler ---
client.on("interactionCreate", (interaction) => void (async () => {
  if (!interaction.isChatInputCommand()) return;
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

// --- 19. Build PromptContext for a guild+channel ---
function buildPromptContext(guildId: string, channelId: string, guild: Guild, guildConfig: GuildConfig): PromptContext {
  // Chat history with trimming
  const history = getChatHistory(channelId);
  const trimmed = trimChatHistory(history, guildConfig.trim);
  // If trimmed, replace the stored history
  if (trimmed.length < history.length) {
    chatHistories.set(channelId, trimmed);
  }

  // Journal summaries
  const journals = listMemories(db, { scope: "journal" });
  const journalSummaries = journals
    .filter((m) => m.shortDescription !== null && m.shortDescription !== "")
    .map((m) => m.shortDescription as string);

  // Upcoming schedules
  const upcoming = listUpcomingForContext(db, guildId);
  const upcomingSchedules = upcoming.map((s) => {
    if (s.type === "cron") return `[cron] ${s.cronExpression ?? "?"}: ${s.messageContent}`;
    const runDate = s.runAt !== null ? new Date(s.runAt).toISOString() : "?";
    return `[one-off at ${runDate}]: ${s.messageContent}`;
  });

  // Emoji context
  refreshEmojiCache(guild);
  const emojis = emojiCache.get(guildId) ?? [];
  const emojiContext = buildEmojiContext(emojis);

  // Display name context from guild members cache
  const members = guild.members.cache.map((m) => ({
    username: m.user.username,
    displayName: m.displayName,
  }));
  const displayNameContext = buildDisplayNameContext(members);

  return {
    persona,
    journalSummaries,
    upcomingSchedules,
    chatHistory: trimmed,
    emojiContext,
    displayNameContext,
  };
}

// --- 20. Build agent tools for a message context ---
function buildAgentTools(guildId: string, channelId: string, guildConfig: GuildConfig, guild: Guild) {
  const memoryTools = createMemoryTools({
    db,
    guildId,
    onMemoryChanged: (memoryId, content) => {
      void embeddingQueue.enqueue({
        id: memoryId,
        text: content,
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
      void deletePoint(qdrant, toPointId(memoryId)).catch((err: unknown) => {
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

  const channelHistoryTool = createChannelHistoryTool({
    guildId,
    fetchMessages: async (chId, limit) => {
      const channel = guild.channels.cache.get(chId);
      if (channel === undefined || !("messages" in channel)) return [];
      const textChannel = channel as TextChannel;
      const msgs = await textChannel.messages.fetch({ limit });
      const result: ChannelMessage[] = [];
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

  const tools = [...memoryTools, searchTool, scheduleTool, memberListTool, channelHistoryTool];

  // Brave search if API key configured
  if (globalConfig.braveApiKey !== undefined && globalConfig.braveApiKey !== "") {
    tools.push(createBraveSearchTool({ apiKey: globalConfig.braveApiKey }));
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
    const guildConfig = getGuildConfig(guildId);

    // Build inbound resolvers and translate
    const inboundResolvers = buildInboundResolvers(guild);
    const translatedContent = translateInbound(message.content, inboundResolvers);

    // Store message in SQLite
    const now = Date.now();
    db.raw
      .prepare(
        `INSERT OR IGNORE INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(message.id, guildId, channelId, message.author.id, message.author.username, message.content, translatedContent, 0, now);

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

    // Append to in-memory chat history
    const history = getChatHistory(channelId);
    history.push({
      author: message.author.username,
      content: translatedContent,
      isBot: false,
    });

    // Process images for multimodal
    const images: { type: "image"; data: string; mimeType: string }[] = [];
    for (const attachment of message.attachments.values()) {
      const contentType = attachment.contentType ?? "";
      if (!contentType.startsWith("image/")) continue;
      try {
        const response = await fetch(attachment.url);
        const buffer = Buffer.from(await response.arrayBuffer());
        const imageContent = await resizeImageToContent(buffer, contentType, guildConfig.imageMaxDimension);
        images.push(imageContent);
      } catch (err) {
        log.warn("image processing failed", {
          attachmentId: attachment.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Build outbound resolvers for the sender
    const outboundResolvers = buildOutboundResolvers(guild);

    function storeBotMessage(sentId: string, rawContent: string, plainContent: string): void {
      const ts = Date.now();
      db.raw
        .prepare(
          `INSERT OR IGNORE INTO messages (id, guild_id, channel_id, user_id, author_username, raw_content, translated_content, is_bot, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(sentId, guildId, channelId, client.user?.id ?? "", client.user?.username ?? "bot", rawContent, plainContent, 1, ts);

      void embeddingQueue.enqueue({
        id: sentId,
        text: plainContent,
        target: "message",
        metadata: {
          guild_id: guildId,
          channel_id: channelId,
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

    // Build multi-message sender
    const channelObj = message.channel as TextChannel;
    const channelActions: ChannelActions = {
      sendReply: async (text) => {
        const translated = translateOutbound(text, outboundResolvers);
        const sent = await message.reply(translated);
        storeBotMessage(sent.id, translated, text);
        // Track bot response in chat history
        const botHistory = getChatHistory(channelId);
        botHistory.push({ author: client.user?.username ?? "bot", content: text, isBot: true });
        return sent.id;
      },
      sendMessage: async (text) => {
        const translated = translateOutbound(text, outboundResolvers);
        const sent = await channelObj.send(translated);
        storeBotMessage(sent.id, translated, text);
        const botHistory = getChatHistory(channelId);
        botHistory.push({ author: client.user?.username ?? "bot", content: text, isBot: true });
        return sent.id;
      },
      startTyping: () => {
        void channelObj.sendTyping().catch(() => {});
      },
    };

    const sender = createMultiMessageSender(channelActions);

    // Build prompt context
    const promptContext = buildPromptContext(guildId, channelId, guild, guildConfig);

    // Build agent tools
    const extraTools = buildAgentTools(guildId, channelId, guildConfig, guild);

    // Build incoming message
    const incoming: IncomingMessage = {
      content: message.content,
      authorId: message.author.id,
      authorUsername: message.author.username,
      botUserId: client.user?.id ?? "",
      mentionedUserIds: [...message.mentions.users.keys()],
      translatedContent,
      images: images.length > 0 ? images : undefined,
    };

    // Build handler deps
    const deps: HandlerDeps = {
      globalConfig,
      guildConfig,
      promptContext,
      sender,
      extraTools,
      log: log.child({ guildId, channelId }),
    };

    // Run the handler
    const result = await handleMessage(incoming, deps);

    if (result.triggered) {
      log.debug("message handled", {
        guildId,
        channelId,
        trigger: result.triggerResult,
        agentRan: result.agentRan,
      });
    }
  } catch (err) {
    log.error("messageCreate handler error", {
      messageId: message.id,
      guildId: message.guildId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
})());

// --- Health check summary ---
log.info("health check passed — all systems ready", {
  uptimeMs: Date.now() - startTime,
  guilds: guildConfigs.size,
  schedulerJobs: scheduler.activeCount(),
});

// --- Graceful shutdown ---
async function shutdown(signal: string): Promise<void> {
  log.info("shutting down", { signal });

  clearInterval(memoryCleanupTimer);
  scheduler.stop();
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
