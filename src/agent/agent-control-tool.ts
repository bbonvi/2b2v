import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentJobStore, BackgroundHandoffTarget } from "./job-runtime.ts";

const SpawnAgentParams = Type.Object({
  task_name: Type.String({ minLength: 1, maxLength: 80 }),
  message: Type.String({
    minLength: 1,
    description: "Self-contained assignment: objective, purpose, relevant facts and identifiers, constraints, completion criteria, and whether visible Discord action is allowed.",
  }),
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
  handoffTarget: BackgroundHandoffTarget;
  parentJobId?: string;
  runAgentJob: (jobId: string) => Promise<void>;
  trackAgentJob: (task: Promise<void>) => void;
}): AgentTool[] {
  const spawn: AgentTool = {
    name: "spawn_agent",
    label: "spawn_agent",
    description: "Start a durable asynchronous copy of 2B for one explicit, self-contained task.",
    parameters: SpawnAgentParams,
    execute: (_toolCallId, params): Promise<AgentToolResult<unknown>> => {
      const request = params as {
        task_name: string;
        message: string;
        model_profile?: string;
      };
      const job = input.store.enqueueBackgroundAgent({
        guildId: input.guildId,
        channelId: input.channelId,
        requesterId: input.requesterId,
        requesterUsername: input.requesterUsername,
        sourceMessageId: input.sourceMessageId,
        sourceQuote: input.sourceQuote,
        taskName: request.task_name,
        message: request.message,
        handoffTarget: input.handoffTarget,
        ...(input.parentJobId !== undefined ? { parentJobId: input.parentJobId } : {}),
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
    description: "Send a follow-up to a running, waiting, or yielded agent. A waiting or yielded agent resumes asynchronously.",
    parameters: SendAgentMessageParams,
    execute: (_toolCallId, params): Promise<AgentToolResult<unknown>> => {
      const request = params as { target: string; message: string };
      const visible = input.store.get(request.target);
      if (visible === undefined) throw new Error(`Agent ${request.target} was not found.`);
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
