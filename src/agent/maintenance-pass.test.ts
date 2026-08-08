import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { splitDeferredTools } from "../../node_modules/@earendil-works/pi-ai/dist/utils/deferred-tools.js";
import { createHash } from "node:crypto";
import { handleMessage } from "./handler.ts";
import { runSilentMemoryAgentPass, runSilentToolAgentPass } from "./maintenance-pass.ts";
import { hasMaintenanceMaterial, type ChatCompleteFn, type MaintenancePromptContext } from "./turn-types.ts";
import type { OpenRouterMessage } from "../llm/types.ts";
import { buildCodexContext } from "../llm/codex-chat.ts";
import { TEST_RUNTIME_PROMPTS, makeCodexGlobal, makeContext, makeDeps, makeGlobalConfig, makeGuildConfig, makeMessage, makePromptTransportConfig } from "./handler-test-support.ts";

describe("handleMessage", () => {
  test("silent memory pass stops on wall-clock timeout without recovery completion", async () => {
    const recordMemoryTool: AgentTool = {
      name: "record_memory",
      label: "record_memory",
      description: "Record memory",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Memory update complete." }],
        details: { applied: 0, requested: 1 },
      }),
    };
    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => {
          reject(request.signal?.reason instanceof Error ? request.signal.reason : new Error("aborted"));
        }, { once: true });
      });
    };

    await runSilentMemoryAgentPass({
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({
        replyLoop: { maxToolCalls: 64, wallClockTimeoutMs: 1, llmOutputTimeoutMs: 10_000 },
      }),
      context: makeContext(),
      personaPrompt: "You are a test bot.",
      runtimePrompts: TEST_RUNTIME_PROMPTS,
      incomingMessage: makeMessage(),
      userContent: "remember I like concise answers",
      assistantReply: "got it",
      visibleReplySent: true,
      tools: [recordMemoryTool],
      completeChat,
    });

    expect(calls).toBe(1);
  });

  test("silent memory pass stops after one successful mutation batch", async () => {
    const toolCalls: unknown[] = [];
    let llmCalls = 0;
    const recordMemoryTool: AgentTool = {
      name: "record_memory",
      label: "record_memory",
      description: "Record memory",
      parameters: Type.Object({}),
      execute: (_id, params) => {
        toolCalls.push(params);
        return Promise.resolve({
          content: [{ type: "text", text: "Memory update complete." }],
          details: { applied: 0, requested: 1 },
        });
      },
    };
    const completeChat: ChatCompleteFn = () => {
      llmCalls += 1;
      return Promise.resolve({
        text: "",
        toolCalls: [{ id: "call-1", type: "function", function: { name: "record_memory", arguments: "{}" } }],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await runSilentMemoryAgentPass({
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({
        memoryExtraction: {
          modelProfile: "main",
          postReply: true,
          maxToolCalls: 2,
          ambient: { enabled: false, everyMessages: 300, maxBatchMessages: 300, minIntervalSeconds: 600 },
        },
      }),
      context: makeContext(),
      personaPrompt: "You are a test bot.",
      runtimePrompts: TEST_RUNTIME_PROMPTS,
      incomingMessage: makeMessage(),
      userContent: "remember I like concise answers",
      assistantReply: "got it",
      visibleReplySent: true,
      tools: [recordMemoryTool],
      completeChat,
    });

    expect(toolCalls).toHaveLength(1);
    expect(llmCalls).toBe(1);
  });

  test("silent memory pass keeps optional visible-user memories separate without blank gaps", async () => {
    const recordMemoryTool: AgentTool = {
      name: "record_memory",
      label: "record_memory",
      description: "Record memory",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [], details: {} }),
    };
    let controlMessage = "";
    const completeChat: ChatCompleteFn = (request) => {
      const last = request.messages[request.messages.length - 1];
      controlMessage = typeof last?.content === "string" ? last.content : "";
      return Promise.resolve({
        text: "",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await runSilentMemoryAgentPass({
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig(),
      context: makeContext(),
      personaPrompt: "You are a test bot.",
      runtimePrompts: TEST_RUNTIME_PROMPTS,
      incomingMessage: makeMessage(),
      userContent: "remember that Bob likes tea",
      assistantReply: "understood",
      visibleReplySent: true,
      visibleUserMemoryContext: "## Existing Memories For Other Visible Users\n### @bob\n- Likes tea.",
      tools: [recordMemoryTool],
      completeChat,
    });

    expect(controlMessage.startsWith("## Existing Memories For Other Visible Users\n")).toBe(true);
    expect(controlMessage).toContain("\n\n## Execution Mode: Memory Maintenance\n");
    expect(controlMessage.match(/Current time for expiresIn and importantUntil decisions:/g)).toHaveLength(1);
    expect(controlMessage).not.toContain("\n\n\n");
  });

  test("silent memory pass retries after a tool-reported error", async () => {
    const toolCalls: unknown[] = [];
    const recordMemoryTool: AgentTool = {
      name: "record_memory",
      label: "record_memory",
      description: "Record memory",
      parameters: Type.Object({}),
      execute: (_id, params) => {
        toolCalls.push(params);
        return Promise.resolve(toolCalls.length === 1
          ? {
              content: [{ type: "text" as const, text: "Memory update rejected: invalid target." }],
              details: { error: true as const },
            }
          : {
              content: [{ type: "text" as const, text: "Memory update complete." }],
              details: { applied: 1, requested: 1 },
            });
      },
    };
    let llmCalls = 0;
    let retrySawError = false;
    const completeChat: ChatCompleteFn = (request) => {
      llmCalls += 1;
      if (llmCalls === 2) {
        retrySawError = JSON.stringify(request.messages).includes("Memory update rejected: invalid target.");
      }
      return Promise.resolve({
        text: "",
        toolCalls: [{
          id: `call-${llmCalls}`,
          type: "function",
          function: { name: "record_memory", arguments: "{}" },
        }],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await runSilentMemoryAgentPass({
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig({
        memoryExtraction: {
          modelProfile: "main",
          postReply: true,
          maxToolCalls: 2,
          ambient: { enabled: false, everyMessages: 300, maxBatchMessages: 300, minIntervalSeconds: 600 },
        },
      }),
      context: makeContext(),
      personaPrompt: "You are a test bot.",
      runtimePrompts: TEST_RUNTIME_PROMPTS,
      incomingMessage: makeMessage(),
      userContent: "remember I like concise answers",
      assistantReply: "got it",
      visibleReplySent: true,
      tools: [recordMemoryTool],
      completeChat,
    });

    expect(toolCalls).toHaveLength(2);
    expect(llmCalls).toBe(2);
    expect(retrySawError).toBe(true);
  });

  test("silent maintenance executes the full successful mutation round before stopping", async () => {
    const executed: string[] = [];
    const makeTool = (name: string): AgentTool => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      execute: () => {
        executed.push(name);
        return Promise.resolve({
          content: [{ type: "text", text: `${name} complete.` }],
          details: { applied: 1 },
        });
      },
    });
    let llmCalls = 0;
    const completeChat: ChatCompleteFn = () => {
      llmCalls += 1;
      return Promise.resolve({
        text: "",
        toolCalls: [
          { id: "memory-call", type: "function", function: { name: "record_memory", arguments: "{}" } },
          { id: "thread-call", type: "function", function: { name: "record_inner_threads", arguments: "{}" } },
        ],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };

    await runSilentToolAgentPass({
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig(),
      context: makeContext(),
      personaPrompt: "You are a test bot.",
      runtimePrompts: TEST_RUNTIME_PROMPTS,
      incomingMessage: makeMessage(),
      userContent: "maintenance",
      assistantReply: "",
      visibleReplySent: false,
      tools: [makeTool("record_memory"), makeTool("record_inner_threads")],
      runtimeInstruction: "Private maintenance.",
      controlMessage: "Apply all useful maintenance.",
      maxToolCalls: 2,
      terminateAfterSuccessfulToolRoundNames: ["record_memory", "record_inner_threads"],
      completeChat,
    });

    expect(executed).toEqual(["record_memory", "record_inner_threads"]);
    expect(llmCalls).toBe(1);
  });

  test("calls background memory extraction after send", async () => {
    const afterReplyCalls: unknown[] = [];
    const afterReply = (request: unknown): Promise<void> => {
      afterReplyCalls.push(request);
      return Promise.resolve();
    };
    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        afterReply,
        context: makeContext({
          sections: [
            { label: "Server Members", text: "## Server Members\n@user", cached: false, role: "developer" },
            { label: "Memories", text: "## Memory\n- 1 [@user] [preference] concise", cached: false, role: "developer" },
            { label: "Chat History — Older", text: "## Chat History — Older\n[@old]: cached", cached: true, role: "system" },
            { label: "Chat History — Newer", text: "## Chat History\n[@bob]: relevant context", cached: false, role: "developer" },
            { label: "Current Context", text: "Guild: g1", cached: false, role: "developer" },
          ],
        }),
      }),
    );

    expect(afterReplyCalls).toHaveLength(1);
    expect(afterReplyCalls[0]).toMatchObject({
      sourceMessageId: "msg-1",
      userMessage: "hello bot",
      assistantReply: "hello user",
      recentContext: "## Chat History\n[@bob]: relevant context",
      visibleReplySent: true,
    });
    const memoryRequest = afterReplyCalls[0] as { recentContext: string };
    expect(memoryRequest.recentContext).not.toContain("Server Members");
    expect(memoryRequest.recentContext).not.toContain("cached");
    const maintenanceRequest = afterReplyCalls[0] as {
      maintenanceTranscript?: Array<{ role: string; content?: unknown }>;
      availableTools?: Array<{ name: string }>;
      promptContext?: {
        sessionId?: string;
        stableSections: Array<{ text: string }>;
        toolContractSignature?: string;
      };
    };
    expect(maintenanceRequest.maintenanceTranscript?.some((message) => message.role === "assistant" && message.content === "hello user")).toBe(true);
    expect(maintenanceRequest.availableTools).toBeDefined();
    expect(maintenanceRequest.promptContext).toBeDefined();
    expect(maintenanceRequest.promptContext?.toolContractSignature).toMatch(/^[a-f0-9]{64}$/);
    expect(maintenanceRequest.promptContext?.stableSections.some((section) => section.text === TEST_RUNTIME_PROMPTS.reply.trim())).toBe(true);
    expect(JSON.stringify(maintenanceRequest.promptContext?.stableSections)).not.toContain("Silent Memory Pass");
  });

  test("maintenance material includes silent user-only turns", () => {
    expect(hasMaintenanceMaterial({ userMessage: "clanker", assistantReply: "" })).toBe(true);
    expect(hasMaintenanceMaterial({ userMessage: "", assistantReply: "<ignore>not dignifying that</ignore>" })).toBe(true);
    expect(hasMaintenanceMaterial({ userMessage: "", assistantReply: "" })).toBe(false);
  });

  test("silent maintenance passes continue one cached transcript and tool contract", async () => {
    const transcript: OpenRouterMessage[] = [
      { role: "user", content: "hello bot" },
      { role: "assistant", content: "hello user" },
    ];
    const recordMemoryTool: AgentTool = {
      name: "record_memory",
      label: "record_memory",
      description: "Record memory",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "memory recorded" }], details: {} }),
    };
    const recordRelationshipTool: AgentTool = {
      name: "record_relationship",
      label: "record_relationship",
      description: "Record relationship",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "relationship recorded" }], details: {} }),
    };
    const recordInnerThreadsTool: AgentTool = {
      name: "record_inner_threads",
      label: "record_inner_threads",
      description: "Record inner threads",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "inner thread recorded" }], details: {} }),
    };
    const maintenanceTools = [recordMemoryTool, recordRelationshipTool, recordInnerThreadsTool];
    const maintenanceToolContractSignature = createHash("sha256")
      .update(JSON.stringify(maintenanceTools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))))
      .digest("hex");
    let relationshipSawMemoryResult = false;
    let innerThreadsSawPriorResults = false;
    const promptPayloads: unknown[] = [];
    const sessionIds: Array<string | undefined> = [];
    const toolNameSets: string[][] = [];
    const completeChat: ChatCompleteFn = (request) => {
      const payload = { messages: request.messages.map((message) => ({ role: message.role, content: message.content })) };
      request.onPayload?.(payload);
      promptPayloads.push(payload);
      sessionIds.push(request.sessionId);
      toolNameSets.push(request.tools?.map((tool) => tool.function.name) ?? []);
      const last = request.messages[request.messages.length - 1];
      const control = typeof last?.content === "string" ? last.content : "";
      if (control.includes("Memory Maintenance")) {
        return Promise.resolve({
          text: "",
          toolCalls: [{ id: "mem-call", type: "function", function: { name: "record_memory", arguments: "{}" } }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      if (control.includes("Relationship Maintenance")) {
        relationshipSawMemoryResult = JSON.stringify(request.messages).includes("memory recorded");
        return Promise.resolve({
          text: "",
          toolCalls: [{ id: "relationship-call", type: "function", function: { name: "record_relationship", arguments: "{}" } }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      if (control.includes("Inner Thread Maintenance")) {
        const serialized = JSON.stringify(request.messages);
        innerThreadsSawPriorResults = serialized.includes("memory recorded")
          && serialized.includes("relationship recorded");
        return Promise.resolve({
          text: "",
          toolCalls: [{ id: "inner-thread-call", type: "function", function: { name: "record_inner_threads", arguments: "{}" } }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      return Promise.resolve({
        text: "",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };
    const common = {
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig(),
      context: makeContext(),
      personaPrompt: "You are a test bot.",
      runtimePrompts: TEST_RUNTIME_PROMPTS,
      incomingMessage: makeMessage(),
      userContent: "hello bot",
      assistantReply: "hello user",
      visibleReplySent: true,
      transcript,
      promptContext: {
        provider: "openrouter" as const,
        model: "moonshotai/kimi-k2.5",
        transport: makePromptTransportConfig().openrouter,
        stableSections: [{ role: "developer" as const, text: "VISIBLE STABLE PROMPT", target: "input" as const, cacheGroup: "runtime" }],
        initialRoles: ["user" as const],
        sessionId: "same-visible-session",
        promptCaching: { enabled: true },
        toolContractSignature: maintenanceToolContractSignature,
      },
      completeChat,
    };

    await runSilentMemoryAgentPass({ ...common, tools: maintenanceTools });
    await runSilentToolAgentPass({
      ...common,
      tools: maintenanceTools,
      runtimeInstruction: "## Silent Relationship Pass",
      controlMessage: "## Execution Mode: Relationship Maintenance\nPrivate relationship maintenance is active.",
      terminateAfterSuccessfulToolRoundNames: ["record_relationship"],
    });
    await runSilentToolAgentPass({
      ...common,
      tools: maintenanceTools,
      runtimeInstruction: "## Silent Inner Thread Pass",
      controlMessage: "## Execution Mode: Inner Thread Maintenance\nPrivate inner-thread maintenance is active.",
      terminateAfterSuccessfulToolRoundNames: ["record_inner_threads"],
    });

    expect(relationshipSawMemoryResult).toBe(true);
    expect(innerThreadsSawPriorResults).toBe(true);
    expect(sessionIds).toHaveLength(3);
    expect(new Set(sessionIds)).toEqual(new Set(["same-visible-session"]));
    expect(toolNameSets).toEqual(toolNameSets.map(() => [
      "record_memory",
      "record_relationship",
      "record_inner_threads",
    ]));
    expect(JSON.stringify(promptPayloads)).toContain("VISIBLE STABLE PROMPT");
    expect(JSON.stringify(promptPayloads)).not.toContain("Silent Memory Pass");
  });

  test("Codex maintenance extends the actor tool surface without changing its immediate prefix", async () => {
    const makeMaintenanceTool = (name: string): AgentTool => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [{ type: "text", text: `${name} complete` }], details: {} }),
    });
    const searchTools = makeMaintenanceTool("search_tools");
    const fetchUrl = makeMaintenanceTool("fetch_url");
    const recordMemory = makeMaintenanceTool("record_memory");
    const recordRelationship = makeMaintenanceTool("record_relationship");
    const actorTools = [searchTools, fetchUrl];
    const actorToolContractSignature = createHash("sha256")
      .update(JSON.stringify(actorTools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))))
      .digest("hex");
    const transcript: OpenRouterMessage[] = [
      { role: "user", content: "read the linked page" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "actor-search",
          type: "function",
          function: { name: "search_tools", arguments: "{\"query\":\"fetch page\"}" },
        }],
      },
      {
        role: "tool",
        name: "search_tools",
        tool_call_id: "actor-search",
        content: "Enabled private tools: fetch_url",
        addedToolNames: ["fetch_url"],
      },
      { role: "assistant", content: "done" },
    ];
    const actorTranscript = structuredClone(transcript);
    const promptContext = {
      provider: "openai-codex" as const,
      model: "gpt-5.6-sol",
      transport: makePromptTransportConfig().openaiCodex,
      stableSections: [{ role: "developer" as const, text: "STABLE ACTOR PROMPT", target: "input" as const }],
      initialRoles: ["user" as const],
      sessionId: "actor-session",
      promptCacheKey: "actor-cache-key",
      promptCaching: { enabled: true },
      toolContractSignature: actorToolContractSignature,
      activeToolNames: ["search_tools", "fetch_url"],
    };
    const placements: Array<{
      promptCacheKey?: string;
      immediate: string[];
      deferred: string[];
      messages: OpenRouterMessage[];
    }> = [];
    const completeChat: ChatCompleteFn = (request) => {
      const placement = splitDeferredTools(buildCodexContext(request), true);
      placements.push({
        ...(request.promptCacheKey !== undefined ? { promptCacheKey: request.promptCacheKey } : {}),
        immediate: placement.immediate.map((tool) => tool.name),
        deferred: [...placement.deferred.keys()],
        messages: structuredClone(request.messages),
      });
      return Promise.resolve({
        text: "",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };
    const common = {
      globalConfig: makeCodexGlobal({ model: "gpt-5.6-sol" }),
      guildConfig: makeGuildConfig(),
      context: makeContext(),
      personaPrompt: "You are a test bot.",
      runtimePrompts: TEST_RUNTIME_PROMPTS,
      incomingMessage: makeMessage(),
      userContent: "hello bot",
      assistantReply: "done",
      visibleReplySent: true,
      transcript,
      promptContext,
      runtimeInstruction: "Private maintenance.",
      completeChat,
    };

    await runSilentToolAgentPass({
      ...common,
      tools: [searchTools, fetchUrl, recordMemory, recordRelationship],
      controlMessage: "Memory Maintenance",
      terminateAfterSuccessfulToolRoundNames: ["record_memory"],
    });
    await runSilentToolAgentPass({
      ...common,
      tools: [searchTools, fetchUrl, recordMemory, recordRelationship],
      controlMessage: "Relationship Maintenance",
      terminateAfterSuccessfulToolRoundNames: ["record_relationship"],
    });

    expect(placements).toHaveLength(2);
    expect(placements.map((placement) => placement.promptCacheKey)).toEqual([
      "actor-cache-key",
      "actor-cache-key",
    ]);
    expect(placements[0]?.immediate).toEqual(["search_tools"]);
    expect(placements[0]?.deferred).toEqual(["fetch_url", "record_memory"]);
    expect(placements[1]?.immediate).toEqual(["search_tools"]);
    expect(placements[1]?.deferred).toEqual([
      "fetch_url",
      "record_memory",
      "record_relationship",
    ]);
    expect(placements[0]?.messages.slice(0, actorTranscript.length)).toEqual(actorTranscript);
    expect(promptContext.activeToolNames).toEqual([
      "search_tools",
      "fetch_url",
      "record_memory",
      "record_relationship",
    ]);
  });

  test("Codex maintenance keeps one tool prefix when its model differs from the actor", async () => {
    const makeTool = (name: string): AgentTool => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [{ type: "text", text: `${name} complete` }], details: {} }),
    });
    const searchTools = makeTool("search_tools");
    const writerNames = ["record_memory", "record_relationship", "record_inner_threads"];
    const tools = [searchTools, ...writerNames.map(makeTool)];
    const placements: Array<{
      promptCacheKey?: string;
      immediate: string[];
      deferred: string[];
      messages: OpenRouterMessage[];
    }> = [];
    const completeChat: ChatCompleteFn = (request) => {
      const placement = splitDeferredTools(buildCodexContext(request), true);
      placements.push({
        ...(request.promptCacheKey !== undefined ? { promptCacheKey: request.promptCacheKey } : {}),
        immediate: placement.immediate.map((tool) => tool.name),
        deferred: [...placement.deferred.keys()],
        messages: structuredClone(request.messages),
      });
      return Promise.resolve({
        text: "",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
      });
    };
    const common = {
      globalConfig: makeCodexGlobal({ model: "gpt-5.6-luna" }),
      guildConfig: makeGuildConfig(),
      context: makeContext(),
      personaPrompt: "You are a test bot.",
      runtimePrompts: TEST_RUNTIME_PROMPTS,
      incomingMessage: makeMessage(),
      userContent: "hello bot",
      assistantReply: "done",
      visibleReplySent: true,
      transcript: [
        { role: "user" as const, content: "hello bot" },
        { role: "assistant" as const, content: "done" },
      ],
      promptContext: {
        provider: "openai-codex" as const,
        model: "gpt-5.6-sol",
        transport: makePromptTransportConfig().openaiCodex,
        stableSections: [],
        initialRoles: ["user" as const],
        promptCacheKey: "actor-cache-key",
        promptCaching: { enabled: true },
        activeToolNames: ["search_tools"],
      },
      tools,
      runtimeInstruction: "Private maintenance.",
      completeChat,
    };

    let transcript: OpenRouterMessage[] = common.transcript;
    let promptContext: MaintenancePromptContext | undefined = common.promptContext;
    for (const writerName of writerNames) {
      const result = await runSilentToolAgentPass({
        ...common,
        transcript,
        promptContext,
        controlMessage: `${writerName} maintenance`,
        terminateAfterSuccessfulToolRoundNames: [writerName],
      });
      transcript = result.transcript;
      promptContext = result.promptContext ?? promptContext;
    }

    expect(placements.map((placement) => placement.immediate)).toEqual([
      ["search_tools"],
      ["search_tools"],
      ["search_tools"],
    ]);
    expect(placements.map((placement) => placement.deferred)).toEqual([
      ["record_memory"],
      ["record_memory", "record_relationship"],
      ["record_memory", "record_relationship", "record_inner_threads"],
    ]);
    expect(new Set(placements.map((placement) => placement.promptCacheKey)).size).toBe(1);
    expect(placements[0]?.promptCacheKey).toMatch(/^2b2v:prompt:/);
    expect(JSON.stringify(placements[1]?.messages)).toContain("record_memory maintenance");
    expect(JSON.stringify(placements[2]?.messages)).toContain("record_relationship maintenance");
    expect(promptContext.model).toBe("gpt-5.6-luna");
  });

  test("incompatible maintenance models receive portable raw actor evidence", async () => {
    let capturedMessages: OpenRouterMessage[] = [];
    const transcript: OpenRouterMessage[] = [
      { role: "user", content: "private opportunity" },
      {
        role: "assistant",
        content: "<thoughts>I want to keep studying this mechanism.</thoughts>",
        tool_calls: [{
          id: "search-call",
          type: "function",
          function: { name: "web_search", arguments: "{\"query\":\"mechanism\"}" },
        }],
      },
      { role: "tool", name: "web_search", tool_call_id: "search-call", content: "A useful result." },
    ];
    const maintenanceTool: AgentTool = {
      name: "record_memory",
      label: "record_memory",
      description: "Record memory",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "recorded" }], details: {} }),
    };

    await runSilentToolAgentPass({
      globalConfig: makeGlobalConfig(),
      guildConfig: makeGuildConfig(),
      context: makeContext(),
      personaPrompt: "You are a test bot.",
      runtimePrompts: TEST_RUNTIME_PROMPTS,
      incomingMessage: makeMessage(),
      userContent: "private opportunity",
      assistantReply: "visible reply only",
      visibleReplySent: true,
      transcript,
      promptContext: {
        provider: "openrouter",
        model: "different/model",
        transport: makePromptTransportConfig().openrouter,
        stableSections: [],
        initialRoles: ["user"],
        promptCaching: { enabled: true },
      },
      tools: [maintenanceTool],
      runtimeInstruction: "Private maintenance.",
      controlMessage: "Decide memory changes.",
      completeChat: (request) => {
        capturedMessages = request.messages;
        return Promise.resolve({
          text: "",
          toolCalls: [],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      },
    });

    const serialized = JSON.stringify(capturedMessages);
    expect(serialized).toContain("## Completed Actor Turn Evidence");
    expect(serialized).toContain("<thoughts>I want to keep studying this mechanism.</thoughts>");
    expect(serialized).toContain("web_search({\\\"query\\\":\\\"mechanism\\\"})");
    expect(serialized).toContain("A useful result.");
    expect(capturedMessages.some((message) => message.content === "Decide memory changes.")).toBe(true);
  });

});
