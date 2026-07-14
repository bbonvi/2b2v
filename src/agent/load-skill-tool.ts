import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { PromptSkillBundle } from "../config/instruction-bundle.ts";

export interface LoadSkillToolDeps {
  skills: PromptSkillBundle;
}

export interface LoadedSkillDetails {
  skillId: string;
  requiredForTools: string[];
}

const LoadSkillParams = Type.Object({
  skill: Type.String({
    minLength: 1,
    description: "Specialized instruction pack needed before a required private action.",
  }),
});

function availableSkillIds(skills: PromptSkillBundle): string {
  const ids = Object.keys(skills.byId).sort((a, b) => a.localeCompare(b, "en"));
  return ids.length > 0 ? ids.join(", ") : "(none)";
}

/** Create the tool that loads manifest-backed prompt skills on demand. */
export function createLoadSkillTool(deps: LoadSkillToolDeps): AgentTool {
  return {
    name: "load_skill",
    label: "load_skill",
    description: "Load a specialized private instruction pack before taking a required action.",
    parameters: LoadSkillParams,

    execute: (_toolCallId: string, params: unknown): Promise<AgentToolResult<LoadedSkillDetails | { error: boolean }>> => {
      const p = params as { skill?: unknown };
      const skillId = typeof p.skill === "string" ? p.skill.trim() : "";
      const skill = deps.skills.byId[skillId];
      if (skill === undefined) {
        return Promise.resolve({
          content: [{ type: "text", text: `Unknown skill "${skillId}". Available skills: ${availableSkillIds(deps.skills)}.` }],
          details: { error: true },
        });
      }
      return Promise.resolve({
        content: [{ type: "text", text: skill.content }],
        details: {
          skillId: skill.id,
          requiredForTools: skill.requiredForTools,
        },
      });
    },
  };
}
