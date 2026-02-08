import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";

/** Callback that fires the Discord typing indicator. */
export type TypingCallback = () => void;

/**
 * Create the start_typing AgentTool with an injected typing callback.
 * Triggers typing immediately and returns a trivial success result.
 */
export function createStartTypingTool(onTyping: TypingCallback): AgentTool {
  return {
    name: "start_typing",
    label: "Start Typing",
    description:
      "Trigger the typing indicator in the current Discord channel. If planning a reply, call this before every tool_call (including send_message) until finished.",
    parameters: Type.Object({}),
    execute: (): Promise<AgentToolResult<Record<string, never>>> => {
      onTyping();
      return Promise.resolve({
        content: [{ type: "text", text: "Typing indicator sent." }],
        details: {},
      });
    },
  };
}
