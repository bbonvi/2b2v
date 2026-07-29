import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PromptSkillBundle } from "../config/instruction-bundle.ts";
import {
  createSearchToolsTool,
  initialActorToolNames,
  initialMaintenanceToolNames,
  requestedToolActivations,
  ToolCatalog,
  type ToolSearchDetails,
  withActivatedToolNames,
} from "./tool-catalog.ts";

function tool(name: string, description = name): AgentTool {
  return {
    name,
    label: name,
    description,
    parameters: Type.Object({}),
    execute: () => Promise.resolve({ content: [{ type: "text", text: "ok" }], details: {} }),
  };
}

const skills: PromptSkillBundle = {
  byId: {
    scheduling: {
      id: "scheduling",
      title: "Scheduling",
      description: "Future actions.",
      requiredForTools: ["schedule_task", "list_scheduled_tasks", "delete_scheduled_task"],
      instructionDocuments: [],
      content: "# Skill: Scheduling",
    },
    discord_threads: {
      id: "discord_threads",
      title: "Discord Threads",
      description: "Thread lifecycle.",
      requiredForTools: ["start_thread", "close_thread"],
      instructionDocuments: [],
      content: "# Skill: Discord Threads",
    },
  },
  indexPrompt: "## Skills",
  requiredByTool: {
    schedule_task: "scheduling",
    list_scheduled_tasks: "scheduling",
    delete_scheduled_task: "scheduling",
    start_thread: "discord_threads",
    close_thread: "discord_threads",
  },
};

describe("ToolCatalog", () => {
  test("keeps the chat-first surface active and defers uncommon tools", () => {
    const tools = [
      tool("load_skill"),
      tool("search_tools"),
      tool("react_to_message"),
      tool("read_asset"),
      tool("web_search"),
      tool("fetch_url"),
      tool("schedule_task"),
      tool("start_thread"),
      tool("close_thread"),
    ];

    const initial = initialActorToolNames(tools);

    expect([...initial]).toEqual([
      "load_skill",
      "search_tools",
      "react_to_message",
      "read_asset",
    ]);
  });

  test("requires callers to opt extension tools into the initial surface", () => {
    const tools = [tool("custom_profile_action")];
    expect([...initialActorToolNames(tools)]).toEqual([]);
    expect([...initialActorToolNames(tools, new Set(["custom_profile_action"]))])
      .toEqual(["custom_profile_action"]);
  });

  test("keeps common notebook tools visible initially but defers management and revision history", () => {
    const tools = [
      tool("find_notebooks"),
      tool("search_notebook"),
      tool("read_notebook"),
      tool("patch_notebook"),
      tool("manage_notebook"),
      tool("list_notebook_revisions"),
    ];
    expect([...initialActorToolNames(tools)]).toEqual([
      "find_notebooks",
      "search_notebook",
      "read_notebook",
      "patch_notebook",
    ]);
  });

  test("adds registered tools once and never activates unknown names", () => {
    const catalog = new ToolCatalog(
      [tool("search_tools"), tool("fetch_url"), tool("web_search")],
      new Set(["search_tools"]),
    );

    expect(catalog.activeTools().map((entry) => entry.name)).toEqual(["search_tools"]);
    expect(catalog.activate(["fetch_url", "missing", "fetch_url"])).toEqual(["fetch_url"]);
    expect(catalog.activate(["fetch_url", "web_search"])).toEqual(["web_search"]);
    expect(catalog.activeTools().map((entry) => entry.name)).toEqual([
      "search_tools",
      "fetch_url",
      "web_search",
    ]);
  });

  test("keeps only discovery and maintenance mutations initially active", () => {
    const tools = [
      tool("search_tools"),
      tool("record_memory"),
      tool("search_memories"),
      tool("fetch_url"),
    ];
    expect([...initialMaintenanceToolNames(tools)]).toEqual(["search_tools", "record_memory"]);
  });
});

describe("search_tools", () => {
  test("requests direct activation for matching searchable tools", async () => {
    const search = createSearchToolsTool({
      tools: [tool("fetch_url"), tool("web_search"), tool("schedule_task")],
      skills,
    });

    const result = await search.execute("call-1", { query: "fetch webpage" });
    const requested = requestedToolActivations(result);
    const details = result.details as ToolSearchDetails;

    expect(details.matches).toContain("fetch_url");
    expect(details.activateToolNames).toContain("fetch_url");
    expect(details.requiredSkills).toEqual([]);
    expect(requested).toContain("fetch_url");
  });

  test("routes skill-gated matches to the required skill", async () => {
    const search = createSearchToolsTool({
      tools: [tool("schedule_task"), tool("web_search")],
      skills,
    });

    const result = await search.execute("call-1", { query: "remind me later" });

    expect(result.details).toMatchObject({
      matches: ["schedule_task"],
      activateToolNames: [],
      requiredSkills: [{ skillId: "scheduling", toolNames: ["schedule_task"] }],
    });
    expect(requestedToolActivations(result)).toEqual([]);
  });

  test("routes rare thread tools through their shared skill", async () => {
    const search = createSearchToolsTool({
      tools: [tool("start_thread"), tool("close_thread")],
      skills,
    });

    const result = await search.execute("call-1", { query: "close thread" });

    expect(result.details).toMatchObject({
      matches: ["close_thread"],
      activateToolNames: [],
      requiredSkills: [{
        skillId: "discord_threads",
        toolNames: ["close_thread"],
      }],
    });
    expect(requestedToolActivations(result)).toEqual([]);
  });

  test("selects one concrete capability per query clause", async () => {
    const search = createSearchToolsTool({
      tools: [
        tool("cancel_agent_job"),
        tool("codex_generate_image"),
        tool("fetch_images"),
        tool("read_asset"),
        tool("search_images"),
        tool("schedule_task"),
        tool("list_scheduled_tasks"),
        tool("delete_scheduled_task"),
        tool("create_event_watch"),
        tool("list_event_watches"),
        tool("delete_event_watch"),
        tool("web_search"),
        tool("fetch_url"),
      ],
      skills: {
        ...skills,
        requiredByTool: {
          ...skills.requiredByTool,
          codex_generate_image: "image_generation",
          create_event_watch: "event_watches",
        },
      },
    });

    const generatedImage = await search.execute("call-image", { query: "generate image" });
    expect(generatedImage.details).toMatchObject({
      matches: ["codex_generate_image"],
      activateToolNames: [],
    });

    const reminder = await search.execute("call-reminder", { query: "set a reminder" });
    expect(reminder.details).toMatchObject({
      matches: ["schedule_task"],
      activateToolNames: [],
    });

    const cancellation = await search.execute("call-cancellation", { query: "cancel scheduled task" });
    expect(cancellation.details).toMatchObject({
      matches: ["delete_scheduled_task"],
      activateToolNames: [],
      requiredSkills: [{ skillId: "scheduling", toolNames: ["delete_scheduled_task"] }],
    });

    const presence = await search.execute("call-watch", { query: "when Alice is online" });
    expect(presence.details).toMatchObject({
      matches: ["create_event_watch"],
      activateToolNames: [],
    });

    const web = await search.execute("call-web", { query: "web search and fetch page" });
    expect(web.details).toMatchObject({
      matches: ["web_search", "fetch_url"],
      activateToolNames: ["web_search", "fetch_url"],
    });
  });

  test("marks only catalog-accepted additions on a loader result", () => {
    const result = withActivatedToolNames({
      content: [{ type: "text", text: "Loaded skill." }],
      details: { requiredForTools: ["schedule_task"] },
    }, ["schedule_task"]);

    expect(result.addedToolNames).toEqual(["schedule_task"]);
    expect(result.content.at(-1)).toEqual({
      type: "text",
      text: "Enabled private tools: schedule_task",
    });
  });
});
