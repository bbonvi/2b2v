import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { VoiceRuntime } from "./runtime.ts";

export interface VoiceToolRequestOrigin {
  guildId: string;
  channelId: string;
  sourceMessageId: string;
  sourceMessageText: string;
  requesterId: string;
  requesterUsername: string;
}

function result(text: string, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details };
}

/** Model tools that control the single live voice presence and durable instruction queue. */
export function createVoiceTools(input: {
  runtime: VoiceRuntime;
  origin: VoiceToolRequestOrigin;
  surface?: "text" | "voice";
}): AgentTool[] {
  const presenceOrigin = {
    requesterId: input.origin.requesterId,
    requesterUsername: input.origin.requesterUsername,
    sourceMessageText: input.origin.sourceMessageText,
  };
  const join: AgentTool = {
    name: "join_voice_channel",
    label: "join_voice_channel",
    description: "Join or move the single live Discord voice presence to one voice channel.",
    parameters: Type.Object({
      channel_id: Type.String({ minLength: 1, description: "Discord voice channel ID from list_channels." }),
    }, { additionalProperties: false }),
    async execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
      const channelId = (params as { channel_id: string }).channel_id;
      if (input.surface === "voice") {
        const scheduled = await input.runtime.requestMove(channelId, presenceOrigin);
        return scheduled.scheduled
          ? result(
            `Move to voice channel ${scheduled.channelId} is scheduled after this live turn finishes.`,
            scheduled,
          )
          : result(`2B is already in voice channel ${scheduled.channelId}.`, scheduled);
      }
      const joined = await input.runtime.move(channelId, presenceOrigin);
      return result(
        joined.moved
          ? `Moved the live voice presence to channel ${joined.channelId}.`
          : `Joined voice channel ${joined.channelId}.`,
        joined,
      );
    },
  };

  const leave: AgentTool = {
    name: "leave_voice_channel",
    label: "leave_voice_channel",
    description: "Leave the current voice channel when departure is actually appropriate.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(): Promise<AgentToolResult<Record<string, unknown>>> {
      if (input.surface === "voice") {
        const scheduled = input.runtime.requestLeave(presenceOrigin);
        return result("Departure is scheduled after this live turn finishes.", scheduled);
      }
      await input.runtime.leave("2B chose to leave the voice channel.");
      return result("Left the voice channel.", { left: true });
    },
  };

  const instruct: AgentTool = {
    name: "instruct_voice_channel",
    label: "instruct_voice_channel",
    description: "Send a durable request to 2B's current voice presence. It may take several room turns to resolve.",
    parameters: Type.Object({
      instruction: Type.String({ minLength: 1, maxLength: 4000 }),
      continue_instruction_id: Type.Optional(Type.String({
        minLength: 1,
        description: "Existing open instruction ID when this is a genuine clarification, not a duplicate request.",
      })),
    }, { additionalProperties: false }),
    execute(_id, params): Promise<AgentToolResult<Record<string, unknown>>> {
      const values = params as { instruction: string; continue_instruction_id?: string };
      const text = values.continue_instruction_id === undefined
        ? values.instruction
        : `Clarification for ${values.continue_instruction_id}: ${values.instruction}`;
      const instruction = input.runtime.instruct({
        instruction: text,
        sourceGuildId: input.origin.guildId,
        sourceChannelId: input.origin.channelId,
        sourceMessageId: input.origin.sourceMessageId,
        sourceMessageText: input.origin.sourceMessageText,
        requesterId: input.origin.requesterId,
        requesterUsername: input.origin.requesterUsername,
      });
      return Promise.resolve(result(
        `Voice instruction ${instruction.id} is queued. This confirms delivery only; its outcome may be delayed.`,
        { instructionId: instruction.id, status: instruction.status },
      ));
    },
  };

  return [join, leave, instruct];
}
