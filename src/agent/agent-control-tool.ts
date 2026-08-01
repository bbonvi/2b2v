import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentJobStore } from "./job-runtime.ts";

const SpawnAgentParams = Type.Object({
  task_name: Type.String({ minLength: 1, maxLength: 80 }),
  message: Type.String({ minLength: 1 }),
  kind: Type.Optional(Type.Union([Type.Literal("workspace"), Type.Literal("persona")])),
  model_profile: Type.Optional(Type.String({ minLength: 1 })),
});
const SendAgentMessageParams = Type.Object({
  target: Type.String({ minLength: 1 }),
  message: Type.String({ minLength: 1 }),
});

export function createAgentControlTools(input: {
  store: AgentJobStore;
  guildId: string;
  channelId: string;
  requesterId: string;
  requesterUsername: string;
  sourceMessageId: string;
  sourceQuote: string;
  runAgentJob: (jobId: string) => Promise<void>;
  trackAgentJob: (task: Promise<void>) => void;
}): AgentTool[] {
  const spawn: AgentTool = {
    name: "spawn_agent",
    label: "spawn_agent",
    description: "Start a durable asynchronous workspace or in-persona agent task.",
    parameters: SpawnAgentParams,
    execute: (_toolCallId, params): Promise<AgentToolResult<unknown>> => {
      const request = params as {
        task_name: string;
        message: string;
        kind?: "workspace" | "persona";
        model_profile?: string;
      };
      const job = input.store.enqueueAgentTask({
        kind: request.kind === "persona" ? "persona_task" : "workspace_agent",
        guildId: input.guildId,
        channelId: input.channelId,
        requesterId: input.requesterId,
        requesterUsername: input.requesterUsername,
        sourceMessageId: input.sourceMessageId,
        sourceQuote: input.sourceQuote,
        taskName: request.task_name,
        message: request.message,
        ...(request.model_profile !== undefined ? { modelProfile: request.model_profile } : {}),
      });
      input.trackAgentJob(input.runAgentJob(job.id));
      return Promise.resolve({
        content: [{ type: "text", text: `Started ${job.kind} ${job.id} (${job.input.taskName}). It will report back asynchronously.` }],
        details: { jobId: job.id, kind: job.kind },
      });
    },
  };

  const send: AgentTool = {
    name: "send_agent_message",
    label: "send_agent_message",
    description: "Send a follow-up to a running or yielded agent. A yielded agent resumes asynchronously.",
    parameters: SendAgentMessageParams,
    execute: (_toolCallId, params): Promise<AgentToolResult<unknown>> => {
      const request = params as { target: string; message: string };
      const visible = input.store.getVisible(request.target, input.guildId, input.channelId);
      if (visible === undefined) throw new Error(`Agent ${request.target} was not found or is not visible in this channel.`);
      const result = input.store.sendAgentMessage(request.target, request.message);
      if (result.shouldRun) input.trackAgentJob(input.runAgentJob(request.target));
      return Promise.resolve({
        content: [{ type: "text", text: result.shouldRun
          ? `Resumed ${request.target} with the follow-up.`
          : `Queued the follow-up for ${request.target}.` }],
        details: { jobId: request.target, resumed: result.shouldRun },
      });
    },
  };

  return [spawn, send];
}
