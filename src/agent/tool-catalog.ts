import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { PromptSkillBundle } from "../config/instruction-bundle.ts";
import { markReadOnlyTool } from "./tool-effects.ts";

export interface ToolCatalogEntry {
  tool: AgentTool;
  group: string;
  summary: string;
  aliases: readonly string[];
}

export interface ToolSearchDetails {
  matches: string[];
  activateToolNames: string[];
  requiredSkills: Array<{ skillId: string; toolNames: string[] }>;
}

const INITIAL_ACTOR_TOOL_NAMES = new Set([
  "list_channel_messages",
  "list_channels",
  "list_chat_users",
  "list_emojis",
  "list_inner_threads",
  "load_skill",
  "react_to_message",
  "read_asset",
  "read_notebook",
  "search_asset",
  "search_channel_messages",
  "search_memories",
  "search_tools",
  "update_current_event_watch",
  "update_current_scheduled_task",
]);

const TOOL_METADATA: Readonly<Record<string, Omit<ToolCatalogEntry, "tool">>> = {
  cancel_agent_job: {
    group: "jobs",
    summary: "Cancel an active asynchronous job, or replace an active image job.",
    aliases: ["stop agent", "cancel job", "stop image generation", "replace image job"],
  },
  close_thread: {
    group: "discord_conversation",
    summary: "Close a Discord thread created by the persona.",
    aliases: ["archive thread", "end thread"],
  },
  codex_generate_image: {
    group: "image_generation",
    summary: "Create, edit, remix, or continue a raster image.",
    aliases: ["generate image", "make picture", "edit image", "remix photo"],
  },
  create_event_watch: {
    group: "future_commitments",
    summary: "React later to a matching Discord message, presence, voice, member, or reaction event.",
    aliases: [
      "watch discord event",
      "watch user online",
      "user online",
      "when user is online",
      "when user posts",
      "when user joins voice",
      "presence watch",
    ],
  },
  delete_event_watch: {
    group: "future_commitments",
    summary: "End an existing Discord event watch.",
    aliases: ["remove event watch", "stop watching event"],
  },
  delete_own_message: {
    group: "discord_conversation",
    summary: "Delete a Discord message authored by the persona.",
    aliases: ["remove my message", "delete bot reply"],
  },
  delete_scheduled_task: {
    group: "future_commitments",
    summary: "End an existing future or recurring scheduled action.",
    aliases: ["cancel reminder", "remove schedule", "stop recurring task"],
  },
  discord_remove_user_timeout: {
    group: "discord_moderation",
    summary: "Remove a Discord member timeout when an administrator requests it.",
    aliases: ["untimeout user", "remove timeout"],
  },
  discord_set_user_timeout: {
    group: "discord_moderation",
    summary: "Temporarily time out a Discord member when an administrator requests it.",
    aliases: ["timeout user", "mute member"],
  },
  dismiss_agent_job: {
    group: "jobs",
    summary: "Close a ready or yielded asynchronous job that no longer needs action.",
    aliases: ["discard job result", "abandon agent handoff", "discard image result"],
  },
  edit_own_message: {
    group: "discord_conversation",
    summary: "Edit a Discord message authored by the persona.",
    aliases: ["correct my message", "edit bot reply"],
  },
  fetch_images: {
    group: "external_images",
    summary: "Inspect one or more exact public image URLs.",
    aliases: ["open image url", "inspect external image", "view remote image"],
  },
  fetch_url: {
    group: "web",
    summary: "Read the content of an exact webpage URL.",
    aliases: ["open webpage", "read link", "fetch page", "fetch webpage"],
  },
  instruct_voice_channel: {
    group: "voice",
    summary: "Queue a durable request for the persona's live voice presence.",
    aliases: ["say in voice", "ask in voice", "voice instruction"],
  },
  join_voice_channel: {
    group: "voice",
    summary: "Join or move to a Discord voice channel.",
    aliases: ["join vc", "enter voice", "move voice"],
  },
  leave_voice_channel: {
    group: "voice",
    summary: "Leave the current Discord voice channel.",
    aliases: ["leave vc", "exit voice"],
  },
  list_agent_jobs: {
    group: "jobs",
    summary: "List active or recent asynchronous jobs across all guilds.",
    aliases: ["agent status", "active jobs", "recent jobs", "image job status"],
  },
  list_channel_messages: {
    group: "discord_history",
    summary: "Read messages around or before a known Discord message.",
    aliases: ["message context", "surrounding messages", "channel history"],
  },
  list_channels: {
    group: "discord_context",
    summary: "List accessible Discord channels, threads, and voice rooms.",
    aliases: ["find channel", "channel id", "voice rooms"],
  },
  list_chat_users: {
    group: "discord_context",
    summary: "List current-guild users and resolve their exact identities or administrator status.",
    aliases: ["find user", "who is online", "admin status", "member id"],
  },
  list_emojis: {
    group: "discord_context",
    summary: "List custom Discord emojis from the current guild or all available guilds.",
    aliases: ["custom emoji", "server emoji"],
  },
  list_event_watches: {
    group: "future_commitments",
    summary: "Inspect active Discord event watches.",
    aliases: ["show watches", "current event watches"],
  },
  list_inner_threads: {
    group: "continuity",
    summary: "Inspect durable private intentions, curiosities, conflicts, and commitments.",
    aliases: ["inner intentions", "open personal threads", "unresolved curiosity"],
  },
  list_notebook_revisions: {
    group: "continuity",
    summary: "Inspect immutable revisions of one persona notebook.",
    aliases: ["notebook history", "notebook revisions", "past notebook version"],
  },
  list_scheduled_tasks: {
    group: "future_commitments",
    summary: "Inspect pending one-off or recurring future actions.",
    aliases: ["show reminders", "current schedules", "pending future tasks"],
  },
  react_to_message: {
    group: "discord_conversation",
    summary: "Acknowledge a Discord message with a reaction instead of text.",
    aliases: ["add reaction", "react emoji", "acknowledge message"],
  },
  read_agent_job: {
    group: "jobs",
    summary: "Inspect the exact input, state, result, and lineage of one asynchronous job.",
    aliases: ["inspect agent", "job details", "agent handoff", "inspect image job"],
  },
  read_asset: {
    group: "chat_assets",
    summary: "Inspect a typed chat image, GIF, audio, video, text, or file asset.",
    aliases: ["read attachment", "view uploaded image", "inspect file", "listen voice message"],
  },
  read_notebook: {
    group: "continuity",
    summary: "Read current or historical notebook content by physical line range.",
    aliases: ["open notebook", "notebook content", "read notebook revision"],
  },
  read_user_avatar: {
    group: "discord_context",
    summary: "Inspect a current-guild user's Discord avatar.",
    aliases: ["profile picture", "user avatar", "pfp"],
  },
  roll_dice: {
    group: "roleplay",
    summary: "Resolve a dice outcome for roleplay.",
    aliases: ["dice roll", "skill check", "random roll"],
  },
  schedule_task: {
    group: "future_commitments",
    summary: "Create a delayed, timed, or recurring future private action.",
    aliases: [
      "set reminder",
      "reminder",
      "remind me",
      "remind later",
      "schedule",
      "schedule later",
      "check later",
      "follow up later",
      "recurring check",
      "cron",
    ],
  },
  search_asset: {
    group: "chat_assets",
    summary: "Search inside a large text attachment or media transcript.",
    aliases: ["search attachment", "find in transcript", "find in file"],
  },
  search_channel_messages: {
    group: "discord_history",
    summary: "Find stored Discord messages, replies, and indexed assets.",
    aliases: ["search chat history", "find old message", "cross channel context"],
  },
  search_images: {
    group: "external_images",
    summary: "Search the public web for visual references and image URLs.",
    aliases: ["image search", "find picture", "visual reference"],
  },
  search_memories: {
    group: "continuity",
    summary: "Inspect durable memories when relevant personal context is uncertain.",
    aliases: ["recall memory", "remember user", "past personal context"],
  },
  find_notebooks: {
    group: "continuity",
    summary: "Find persona notebooks by state, related user, title, or content.",
    aliases: ["find notebook", "search notes", "notebook titles"],
  },
  search_notebook: {
    group: "continuity",
    summary: "Find physical lines inside one known persona notebook.",
    aliases: ["search notebook content", "find in notebook", "search notebook lines"],
  },
  patch_notebook: {
    group: "continuity",
    summary: "Apply revision-checked contextual line hunks to an active notebook.",
    aliases: ["edit notebook", "patch notes", "update notebook lines"],
  },
  manage_notebook: {
    group: "continuity",
    summary: "Create, rewrite, move, trash, or restore a persona notebook.",
    aliases: ["create notebook", "archive notebook", "shelve notebook", "restore notebook"],
  },
  start_thread: {
    group: "discord_conversation",
    summary: "Create a Discord thread for a focused conversation.",
    aliases: ["new thread", "create thread", "make thread", "move to thread"],
  },
  summarize_video: {
    group: "web_media",
    summary: "Extract and understand a video, audio, podcast, or YouTube URL.",
    aliases: ["summarize youtube", "video transcript", "podcast summary"],
  },
  web_search: {
    group: "web",
    summary: "Search the public web for external facts and sources.",
    aliases: ["internet search", "look up online", "current external fact"],
  },
};

const SearchToolsParams = Type.Object({
  query: Type.String({ minLength: 1 }),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 10,
  })),
});

const SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "can",
  "for",
  "i",
  "is",
  "me",
  "my",
  "of",
  "please",
  "the",
  "this",
  "to",
  "you",
]);

const SEARCH_TERM_ALIASES: Readonly<Record<string, string>> = {
  created: "create",
  creating: "create",
  images: "image",
  reminded: "remind",
  reminder: "remind",
  reminders: "remind",
  reminding: "remind",
  scheduled: "schedule",
  schedules: "schedule",
  scheduling: "schedule",
  searched: "search",
  searches: "search",
  searching: "search",
  watched: "watch",
  watches: "watch",
  watching: "watch",
};

function normalizeSearchTerm(term: string): string {
  return SEARCH_TERM_ALIASES[term] ?? term;
}

function searchTerms(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1 && !SEARCH_STOP_WORDS.has(term))
    .map(normalizeSearchTerm);
}

function normalizedSearchPhrase(value: string): string {
  return searchTerms(value).join(" ");
}

function matchingTermCount(queryTerms: readonly string[], candidateTerms: ReadonlySet<string>): number {
  return new Set(queryTerms.filter((term) => candidateTerms.has(term))).size;
}

function entryScore(entry: ToolCatalogEntry, query: string): number {
  const queryTerms = searchTerms(query);
  if (queryTerms.length === 0) return 0;
  const queryPhrase = queryTerms.join(" ");
  const nameTerms = new Set(searchTerms(entry.tool.name));
  const aliasPhrases = entry.aliases.map(normalizedSearchPhrase).filter((phrase) => phrase !== "");
  const aliasTerms = new Set(aliasPhrases.flatMap((phrase) => phrase.split(" ")));
  const summaryTerms = new Set(searchTerms(entry.summary));
  const groupTerms = new Set(searchTerms(entry.group));
  const primaryMatches = new Set([
    ...queryTerms.filter((term) => nameTerms.has(term)),
    ...queryTerms.filter((term) => aliasTerms.has(term)),
  ]).size;
  if (primaryMatches === 0) return 0;

  const namePhrase = [...nameTerms].join(" ");
  let score = namePhrase === queryPhrase ? 200 : 0;
  if (aliasPhrases.includes(queryPhrase)) score += 180;
  if (namePhrase.split(" ").length > 1 && queryPhrase.includes(namePhrase)) score += 70;
  if (aliasPhrases.some((phrase) => phrase.split(" ").length > 1 && queryPhrase.includes(phrase))) {
    score += 60;
  }
  if (aliasPhrases.some((phrase) => !phrase.includes(" ") && queryTerms.includes(phrase))) {
    score += 40;
  }
  score += primaryMatches * 100;
  score += matchingTermCount(queryTerms, summaryTerms) * 3;
  score += matchingTermCount(queryTerms, groupTerms) * 4;
  if (primaryMatches === new Set(queryTerms).size) score += 25;
  return score;
}

function searchClauses(query: string): string[] {
  const clauses = query
    .split(/\b(?:and|then|plus)\b|[,;]/i)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== "");
  return clauses.length > 0 ? clauses : [query];
}

function metadataFor(tool: AgentTool): ToolCatalogEntry {
  const metadata = TOOL_METADATA[tool.name];
  if (metadata !== undefined) return { tool, ...metadata };
  return {
    tool,
    group: "other",
    summary: tool.description,
    aliases: [],
  };
}

/** Per-run registered tools with an additive active subset. */
export class ToolCatalog {
  private readonly byName: Map<string, AgentTool>;
  private readonly activeNames: Set<string>;

  constructor(tools: readonly AgentTool[], initialNames: ReadonlySet<string>) {
    this.byName = new Map(tools.map((tool) => [tool.name, tool]));
    this.activeNames = new Set([...initialNames].filter((name) => this.byName.has(name)));
  }

  allTools(): AgentTool[] {
    return [...this.byName.values()];
  }

  activeTools(): AgentTool[] {
    return [...this.byName.values()].filter((tool) => this.activeNames.has(tool.name));
  }

  activeTool(name: string): AgentTool | undefined {
    return this.activeNames.has(name) ? this.byName.get(name) : undefined;
  }

  registeredTool(name: string): AgentTool | undefined {
    return this.byName.get(name);
  }

  activate(names: readonly string[]): string[] {
    const added: string[] = [];
    for (const name of names) {
      if (!this.byName.has(name) || this.activeNames.has(name)) continue;
      this.activeNames.add(name);
      added.push(name);
    }
    return added;
  }
}

/** Stable chat-first initial tool names plus explicit caller-owned extensions. */
export function initialActorToolNames(
  tools: readonly AgentTool[],
  explicitlyInitialNames: ReadonlySet<string> = new Set(),
): Set<string> {
  return new Set(tools
    .map((tool) => tool.name)
    .filter((name) => INITIAL_ACTOR_TOOL_NAMES.has(name) || explicitlyInitialNames.has(name)));
}

/** Stable actor prefix plus private maintenance retrieval and mutation tools. */
export function initialMaintenanceToolNames(tools: readonly AgentTool[]): Set<string> {
  return new Set(tools
    .map((tool) => tool.name)
    .filter((name) => INITIAL_ACTOR_TOOL_NAMES.has(name)
      || name === "read_relationships"
      || name.startsWith("record_")));
}

/** Create the actor's compact capability discovery tool. */
export function createSearchToolsTool(input: {
  tools: readonly AgentTool[];
  skills: PromptSkillBundle;
}): AgentTool {
  const entries = input.tools
    .filter((tool) => tool.name !== "load_skill" && tool.name !== "search_tools")
    .map(metadataFor);

  return markReadOnlyTool({
    name: "search_tools",
    label: "search_tools",
    description: "",
    parameters: SearchToolsParams,
    execute: (_toolCallId, rawParams): Promise<AgentToolResult<ToolSearchDetails | { error: true }>> => {
      const params = rawParams as { query?: unknown; limit?: unknown };
      const query = typeof params.query === "string" ? params.query.trim() : "";
      if (query === "") {
        return Promise.resolve({
          content: [{ type: "text", text: "query is required." }],
          details: { error: true },
        });
      }
      const limit = typeof params.limit === "number"
        ? Math.max(1, Math.min(10, Math.floor(params.limit)))
        : 5;
      const matches: ToolCatalogEntry[] = [];
      for (const clause of searchClauses(query)) {
        const best = entries
          .map((entry) => ({ entry, score: entryScore(entry, clause) }))
          .filter((match) => match.score > 0)
          .sort((a, b) => {
            const scoreDifference = b.score - a.score;
            return scoreDifference !== 0
              ? scoreDifference
              : a.entry.tool.name.localeCompare(b.entry.tool.name, "en");
          })[0];
        if (best === undefined || matches.some((entry) => entry.tool.name === best.entry.tool.name)) continue;
        matches.push(best.entry);
        if (matches.length >= limit) break;
      }
      if (matches.length === 0) {
        return Promise.resolve({
          content: [{ type: "text", text: `No private capability matched: ${query}` }],
          details: { matches: [], activateToolNames: [], requiredSkills: [] },
        });
      }

      const requiredSkills = new Map<string, string[]>();
      const activateToolNames: string[] = [];
      for (const match of matches) {
        const required = input.skills.requiredByTool[match.tool.name];
        if (required === undefined) {
          activateToolNames.push(match.tool.name);
          continue;
        }
        const skillId = typeof required === "string" ? required : required[0];
        if (skillId === undefined) continue;
        const names = requiredSkills.get(skillId);
        if (names === undefined) {
          requiredSkills.set(skillId, [match.tool.name]);
        } else {
          names.push(match.tool.name);
        }
      }
      const skillMatches = [...requiredSkills].map(([skillId, toolNames]) => ({ skillId, toolNames }));
      const lines = matches.map((entry) => {
        const required = input.skills.requiredByTool[entry.tool.name];
        const skillIds = required === undefined ? [] : typeof required === "string" ? [required] : required;
        const suffix = skillIds.length === 0 ? "" : ` Load one of: ${skillIds.map((id) => `"${id}"`).join(", ")}.`;
        return `- ${entry.tool.name}: ${entry.summary}${suffix}`;
      });
      return Promise.resolve({
        content: [{ type: "text", text: `Matching private capabilities:\n${lines.join("\n")}` }],
        details: {
          matches: matches.map((entry) => entry.tool.name),
          activateToolNames,
          requiredSkills: skillMatches,
        },
      });
    },
  });
}

/** Read a loader's requested catalog additions without trusting arbitrary result fields. */
export function requestedToolActivations(result: AgentToolResult<unknown>): string[] {
  const details = result.details;
  if (details === null || typeof details !== "object") return [];
  const record = details as Record<string, unknown>;
  const requested = Array.isArray(record.activateToolNames)
    ? record.activateToolNames
    : Array.isArray(record.requiredForTools)
      ? record.requiredForTools
      : [];
  return requested.filter((name): name is string => typeof name === "string" && name !== "");
}

/** Attach the additions accepted by the catalog to a loader result. */
export function withActivatedToolNames(
  result: AgentToolResult<unknown>,
  addedToolNames: readonly string[],
): AgentToolResult<unknown> {
  if (addedToolNames.length === 0) return result;
  return {
    ...result,
    content: [
      ...result.content,
      { type: "text", text: `Enabled private tools: ${addedToolNames.join(", ")}` },
    ],
    addedToolNames: [...addedToolNames],
  };
}
