import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { handleMessage } from "./handler.ts";
import type { ChatCompleteFn, MessageSender } from "./turn-types.ts";
import { contentText, makeDeps, makeGuildConfig, makeImageGlobal, makeMessage } from "./handler-test-support.ts";

describe("handleMessage", () => {
  test("forces a final answer when the native tool call budget is exhausted", async () => {
    const toolCalls: unknown[] = [];
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({ query: Type.String() }),
      execute: (_id, params) => {
        toolCalls.push(params);
        return Promise.resolve({ content: [{ type: "text", text: "first result" }], details: {} });
      },
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [
            { id: "call-1", type: "function", function: { name: "lookup", arguments: "{\"query\":\"x\"}" } },
            { id: "call-2", type: "function", function: { name: "lookup", arguments: "{\"query\":\"y\"}" } },
          ],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      expect(request.toolChoice).toBe("none");
      expect(request.tools).toEqual([]);
      expect(request.messages.some((m) =>
        m.role === "tool" && m.tool_call_id === "call-1" && typeof m.content === "string" && m.content.includes("first result")
      )).toBe(true);
      expect(request.messages.some((m) =>
        m.role === "tool" && m.tool_call_id === "call-2" && typeof m.content === "string" && m.content.includes("budget exhausted")
      )).toBe(true);
      return Promise.resolve({
        text: "answer from partial tool results",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer from partial tool results" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        guildConfig: makeGuildConfig({ replyLoop: { maxToolCalls: 1, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 } }),
      }),
    );

    expect(result.responseText).toBe("answer from partial tool results");
    expect(toolCalls).toEqual([{ query: "x" }]);
  });

  test("forces a final answer when the native tool round budget is exhausted", async () => {
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "first result" }], details: {} }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls <= 2) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: `call-${calls}`,
            type: "function",
            function: { name: "lookup", arguments: `{"query":"${calls}"}` },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      expect(request.toolChoice).toBe("none");
      expect(request.tools).toEqual([]);
      expect(request.messages.some((m) =>
        m.role === "tool" && m.tool_call_id === "call-2" && typeof m.content === "string" && m.content.includes("round budget exhausted")
      )).toBe(true);
      return Promise.resolve({
        text: "answer after too many rounds",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer after too many rounds" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        guildConfig: makeGuildConfig({ replyLoop: { maxToolCalls: 1, wallClockTimeoutMs: 45_000, llmOutputTimeoutMs: 12_000 } }),
      }),
    );

    expect(result.responseText).toBe("answer after too many rounds");
    expect(calls).toBe(3);
  });

  test("forces a final answer when agent time expires during an LLM turn", async () => {
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "unused" }], details: {} }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_, reject) => {
          const signal = request.signal;
          if (signal === undefined) {
            reject(new Error("expected abort signal"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
          }, { once: true });
        });
      }

      expect(request.toolChoice).toBe("none");
      expect(request.tools).toEqual([]);
      expect(request.signal?.aborted).toBe(false);
      expect(request.messages.some((m) =>
        m.role === "system"
        && typeof m.content === "string"
        && m.content.includes("turn time budget exhausted")
      )).toBe(true);
      return Promise.resolve({
        text: "answer from available context",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer from available context" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        guildConfig: makeGuildConfig({ replyLoop: { maxToolCalls: 2, wallClockTimeoutMs: 10, llmOutputTimeoutMs: 1_000 } }),
      }),
    );

    expect(result.responseText).toBe("answer from available context");
    expect(calls).toBe(2);
  });

  test("switches to agent-time finalization when time expires during tool-budget final answer", async () => {
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({ query: Type.String() }),
      execute: () => Promise.resolve({ content: [{ type: "text", text: "first result" }], details: {} }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [
            { id: "call-1", type: "function", function: { name: "lookup", arguments: "{\"query\":\"x\"}" } },
            { id: "call-2", type: "function", function: { name: "lookup", arguments: "{\"query\":\"y\"}" } },
          ],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      if (calls === 2) {
        expect(request.toolChoice).toBe("none");
        expect(request.signal).toBeDefined();
        return new Promise((_, reject) => {
          const signal = request.signal;
          if (signal === undefined) {
            reject(new Error("expected abort signal"));
            return;
          }
          signal.addEventListener("abort", () => {
            reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
          }, { once: true });
        });
      }

      expect(request.toolChoice).toBe("none");
      expect(request.tools).toEqual([]);
      expect(request.signal?.aborted).toBe(false);
      expect(request.messages.some((m) =>
        m.role === "tool"
        && m.tool_call_id === "call-2"
        && typeof m.content === "string"
        && m.content.includes("tool call budget exhausted")
      )).toBe(true);
      expect(request.messages.some((m) =>
        m.role === "system"
        && typeof m.content === "string"
        && m.content.includes("turn time budget exhausted")
      )).toBe(true);
      return Promise.resolve({
        text: "answer after finalization timeout",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer after finalization timeout" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        guildConfig: makeGuildConfig({ replyLoop: { maxToolCalls: 1, wallClockTimeoutMs: 50, llmOutputTimeoutMs: 1_000 } }),
      }),
    );

    expect(result.responseText).toBe("answer after finalization timeout");
    expect(calls).toBe(3);
  });

  test("forces a final answer when agent time expires during tool execution", async () => {
    const tool: AgentTool = {
      name: "lookup",
      label: "Lookup",
      description: "Look something up",
      parameters: Type.Object({ query: Type.String() }),
      execute: (_id, _params, signal) => new Promise((_, reject) => {
        if (signal === undefined) {
          reject(new Error("expected abort signal"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error("tool aborted"));
        }, { once: true });
      }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: "{\"query\":\"x\"}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      expect(request.toolChoice).toBe("none");
      expect(request.messages.some((m) =>
        m.role === "tool"
        && m.tool_call_id === "call-1"
        && typeof m.content === "string"
        && m.content.includes("agent time budget exhausted")
      )).toBe(true);
      expect(request.messages.some((m) =>
        m.role === "system"
        && typeof m.content === "string"
        && m.content.includes("turn time budget exhausted")
      )).toBe(true);
      return Promise.resolve({
        text: "answer after timed out tool",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "answer after timed out tool" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        guildConfig: makeGuildConfig({ replyLoop: { maxToolCalls: 2, wallClockTimeoutMs: 10, llmOutputTimeoutMs: 1_000 } }),
      }),
    );

    expect(result.responseText).toBe("answer after timed out tool");
    expect(calls).toBe(2);
  });

  test("passes image tool results back to the model as multimodal context", async () => {
    const tool: AgentTool = {
      name: "read_asset",
      label: "Read Images",
      description: "Read images",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [
          { type: "text", text: "{\"id\":1,\"width\":10,\"height\":10}" },
          { type: "image", data: "abcd", mimeType: "image/jpeg" },
        ],
        details: {},
      }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "read_asset", arguments: "{}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      const multimodal = request.messages.find((m) => m.role === "user" && Array.isArray(m.content));
      expect(multimodal).toBeDefined();
      const parts = Array.isArray(multimodal?.content) ? multimodal.content : [];
      expect(parts.some((part) =>
        part.type === "image_url" && part.image_url.url === "data:image/jpeg;base64,abcd"
      )).toBe(true);

      return Promise.resolve({
        text: "image answer",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "image answer" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [tool], completeChat }),
    );

    expect(result.responseText).toBe("image answer");
  });

  test("uses live OpenRouter metadata instead of static registry for image support", async () => {
    const tool: AgentTool = {
      name: "read_asset",
      label: "Read Images",
      description: "Read images",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [
          { type: "text", text: "{\"id\":1,\"width\":10,\"height\":10}" },
          { type: "image", data: "abcd", mimeType: "image/jpeg" },
        ],
        details: {},
      }),
    };

    let mainCalls = 0;
    let fallbackCalls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      if (request.systemPrompt.includes("Describe images for another Discord chat model")) {
        fallbackCalls += 1;
        return Promise.resolve({
          text: "fallback should not run",
          toolCalls: [],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "fallback should not run" }] },
        });
      }

      mainCalls += 1;
      if (mainCalls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "read_asset", arguments: "{}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      expect(request.messages.some((m) =>
        Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")
      )).toBe(true);
      return Promise.resolve({
        text: "native image answer",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "native image answer" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        modelImageInputSupport: "supported",
        globalConfig: makeImageGlobal("new-vendor/vision-model-not-in-registry"),
        guildConfig: makeGuildConfig({
          imageReading: {
            fallbackEnabled: true,
            fallbackModelProfile: "imageFallback",
          },
        }),
      }),
    );

    expect(result.responseText).toBe("native image answer");
    expect(mainCalls).toBe(2);
    expect(fallbackCalls).toBe(0);
  });

  test("returns a clear tool error instead of image parts for text-only models", async () => {
    const tool: AgentTool = {
      name: "read_asset",
      label: "Read Images",
      description: "Read images",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [
          { type: "text", text: "{\"id\":1,\"width\":10,\"height\":10}" },
          { type: "image", data: "abcd", mimeType: "image/jpeg" },
        ],
        details: {},
      }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "read_asset", arguments: "{}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      const toolMessage = request.messages.find((m) => m.role === "tool" && m.name === "read_asset");
      expect(typeof toolMessage?.content).toBe("string");
      expect(toolMessage?.content).toContain("current LLM endpoint cannot read image input");
      expect(request.messages.some((m) =>
        Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")
      )).toBe(false);

      return Promise.resolve({
        text: "cannot inspect image",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "cannot inspect image" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        globalConfig: makeImageGlobal("deepseek/deepseek-v4-pro:price"),
      }),
    );

    expect(result.responseText).toBe("cannot inspect image");
  });

  test("uses fallback image model when the selected model cannot read image input", async () => {
    const tool: AgentTool = {
      name: "read_asset",
      label: "Read Images",
      description: "Read images",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [
          { type: "text", text: "{\"id\":1,\"width\":10,\"height\":10}" },
          { type: "image", data: "abcd", mimeType: "image/jpeg" },
        ],
        details: {},
      }),
    };

    let mainCalls = 0;
    let imageCalls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      if (request.systemPrompt.includes("Describe images for another Discord chat model")) {
        imageCalls += 1;
        expect(request.systemPrompt).toContain("Describe images for another Discord chat model");
        expect(request.systemPrompt).toContain("race/ethnicity/skin tone");
        expect(request.systemPrompt).toContain("Use normal words like woman");
        expect(request.systemPrompt).toContain("selfie");
        expect(request.systemPrompt).toContain("movie/TV/anime/game frame");
        expect(request.systemPrompt).toContain("actor");
        expect(request.systemPrompt).toContain("vibe");
        expect(request.messages.some((m) =>
          Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")
        )).toBe(true);
        return Promise.resolve({
          text: "A very detailed image description.",
          toolCalls: [],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "A very detailed image description." }] },
        });
      }

      mainCalls += 1;
      if (mainCalls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "read_asset", arguments: "{}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }

      const toolMessage = request.messages.find((m) => m.role === "tool" && m.name === "read_asset");
      expect(toolMessage?.content).toContain("Native image reading was unavailable");
      expect(toolMessage?.content).toContain("fallback image model moonshotai/kimi-k2.5");
      expect(toolMessage?.content).toContain("A very detailed image description.");
      expect(request.messages.some((m) =>
        Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")
      )).toBe(false);

      return Promise.resolve({
        text: "fallback answer",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "fallback answer" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        globalConfig: makeImageGlobal(
          "deepseek/deepseek-v4-pro:price",
          { temperature: 0 },
        ),
        guildConfig: makeGuildConfig({
          imageReading: {
            fallbackEnabled: true,
            fallbackModelProfile: "imageFallback",
          },
        }),
      }),
    );

    expect(result.responseText).toBe("fallback answer");
    expect(mainCalls).toBe(2);
    expect(imageCalls).toBe(1);
  });

  test("recovers when provider rejects image input after an image tool result", async () => {
    const tool: AgentTool = {
      name: "read_asset",
      label: "Read Images",
      description: "Read images",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [
          { type: "text", text: "{\"id\":1,\"width\":10,\"height\":10}" },
          { type: "image", data: "abcd", mimeType: "image/jpeg" },
        ],
        details: {},
      }),
    };

    let calls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "read_asset", arguments: "{}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      if (calls === 2) {
        throw new Error("No endpoints found that support image input; rawResponse={\"error\":{\"message\":\"No endpoints found that support image input\",\"code\":404}}");
      }

      expect(request.messages.some((m) =>
        Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")
      )).toBe(false);
      const toolMessage = request.messages.find((m) => m.role === "tool" && m.name === "read_asset");
      expect(toolMessage?.content).toContain("current LLM endpoint cannot read image input");
      expect(request.messages.some((m) => m.role === "user" && contentText(m.content).includes("## Current Discord Message"))).toBe(true);

      return Promise.resolve({
        text: "cannot inspect image",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "cannot inspect image" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [tool], completeChat }),
    );

    expect(result.responseText).toBe("cannot inspect image");
    expect(calls).toBe(3);
  });

  test("falls back to image description when provider rejects native image input", async () => {
    const tool: AgentTool = {
      name: "read_asset",
      label: "Read Images",
      description: "Read images",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [
          { type: "text", text: "{\"id\":1,\"width\":10,\"height\":10}" },
          { type: "image", data: "abcd", mimeType: "image/jpeg" },
        ],
        details: {},
      }),
    };

    let mainCalls = 0;
    let fallbackCalls = 0;
    const completeChat: ChatCompleteFn = (request) => {
      if (request.systemPrompt.includes("Describe images for another Discord chat model")) {
        fallbackCalls += 1;
        expect(request.messages.some((m) =>
          Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")
        )).toBe(true);
        return Promise.resolve({
          text: "Fallback saw a small square test image.",
          toolCalls: [],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "Fallback saw a small square test image." }] },
        });
      }

      mainCalls += 1;
      if (mainCalls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{
            id: "call-1",
            type: "function",
            function: { name: "read_asset", arguments: "{}" },
          }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      if (mainCalls === 2) {
        throw new Error("No endpoints found that support image input; rawResponse={\"error\":{\"message\":\"No endpoints found that support image input\",\"code\":404}}");
      }

      expect(request.messages.some((m) =>
        Array.isArray(m.content) && m.content.some((part) => part.type === "image_url")
      )).toBe(false);
      const toolMessage = request.messages.find((m) => m.role === "tool" && m.name === "read_asset");
      expect(toolMessage?.content).toContain("Native image reading was unavailable");
      expect(toolMessage?.content).toContain("Fallback saw a small square test image.");
      expect(request.messages.some((m) => m.role === "user" && contentText(m.content).includes("## Current Discord Message"))).toBe(true);

      return Promise.resolve({
        text: "described image answer",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "described image answer" }] },
      });
    };

    const result = await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [tool],
        completeChat,
        globalConfig: makeImageGlobal("moonshotai/kimi-k2.5"),
        guildConfig: makeGuildConfig({
          imageReading: {
            fallbackEnabled: true,
            fallbackModelProfile: "imageFallback",
          },
        }),
      }),
    );

    expect(result.responseText).toBe("described image answer");
    expect(mainCalls).toBe(3);
    expect(fallbackCalls).toBe(1);
  });

  test("start_thread does not route a plain final answer to the created thread", async () => {
    const threadTool: AgentTool = {
      name: "start_thread",
      label: "Start Thread",
      description: "Create a thread",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Thread created" }],
        details: { channel_id: "thread-1", threadName: "Thread", parent_channel_id: "channel-1" },
      }),
    };
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{ id: "call-1", type: "function", function: { name: "start_thread", arguments: "{}" } }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      return Promise.resolve({
        text: "thread answer",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "thread answer" }] },
      });
    };
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [threadTool], completeChat, sender }),
    );

    expect(senderCalls).toEqual([{ text: "thread answer", reply: false, channelId: undefined }]);
  });

  test("after start_thread the model sends inside the thread only with explicit channel_id", async () => {
    const threadTool: AgentTool = {
      name: "start_thread",
      label: "Start Thread",
      description: "Create a thread",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Thread created: channel_id thread-1" }],
        details: { channel_id: "thread-1", threadName: "Thread", parent_channel_id: "channel-1" },
      }),
    };
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{ id: "call-1", type: "function", function: { name: "start_thread", arguments: "{}" } }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      return Promise.resolve({
        text: "<message channel_id=\"thread-1\">thread answer</message>",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "thread answer" }] },
      });
    };
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [threadTool], completeChat, sender, currentChannelId: "channel-1" }),
    );

    expect(senderCalls).toEqual([{ text: "thread answer", reply: false, channelId: "thread-1" }]);
  });

  test("close_thread does not route a plain final answer to the parent", async () => {
    const closeTool: AgentTool = {
      name: "close_thread",
      label: "Close Thread",
      description: "Close a thread",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Thread closed" }],
        details: { channel_id: "thread-1", threadName: "Thread", parent_channel_id: "channel-1" },
      }),
    };
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{ id: "call-1", type: "function", function: { name: "close_thread", arguments: "{}" } }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      return Promise.resolve({
        text: "closed",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "closed" }] },
      });
    };
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({ extraTools: [closeTool], completeChat, sender, runtimePrompts: undefined }),
    );

    expect(senderCalls).toEqual([{ text: "closed", reply: false, channelId: undefined }]);
  });

  test("close_thread suppresses a later plain final answer after closing the current thread", async () => {
    const closeTool: AgentTool = {
      name: "close_thread",
      label: "Close Thread",
      description: "Close a thread",
      parameters: Type.Object({}),
      execute: () => Promise.resolve({
        content: [{ type: "text", text: "Thread closed" }],
        details: { channel_id: "thread-1", threadName: "Thread", parent_channel_id: "channel-1" },
      }),
    };
    let calls = 0;
    const completeChat: ChatCompleteFn = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          text: "",
          toolCalls: [{ id: "call-1", type: "function", function: { name: "close_thread", arguments: "{}" } }],
          rawResponse: {},
          messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [] },
        });
      }
      return Promise.resolve({
        text: "closed",
        toolCalls: [],
        rawResponse: {},
        messageForLogs: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 }, content: [{ type: "text", text: "closed" }] },
      });
    };
    const senderCalls: Array<{ text: string; reply: boolean; channelId?: string }> = [];
    const sender: MessageSender = (text, reply, channelId) => {
      senderCalls.push({ text, reply, channelId });
      return Promise.resolve({ sentMessageId: "sent-1" });
    };

    await handleMessage(
      makeMessage({ mentionedUserIds: ["bot-1"] }),
      makeDeps({
        extraTools: [closeTool],
        completeChat,
        sender,
        currentChannelId: "thread-1",
        runtimePrompts: undefined,
      }),
    );

    expect(senderCalls).toEqual([]);
  });

});
