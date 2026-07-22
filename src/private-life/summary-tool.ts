import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Database } from "../db/database.ts";
import { setPrivateLifeEpisodeSummary } from "../db/private-life-repository.ts";

const Params = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 80 }),
  theme_key: Type.String({ minLength: 1, maxLength: 120 }),
  facets: Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 12 }),
});

type Params = {
  label: string;
  theme_key: string;
  facets: string[];
};

function wordCount(value: string): number {
  return value.trim().split(/\s+/u).filter((part) => part !== "").length;
}

/** Create the maintenance-only tool that gives one episode its compact activity summary. */
export function createPrivateLifeSummaryTool(input: {
  db: Database;
  episodeId: string;
  description: string;
  dryRun?: boolean;
}): AgentTool {
  return {
    name: "record_private_life_episode",
    label: "Record Private-Life Episode",
    description: input.description,
    parameters: Params,
    execute: (_toolCallId, raw): Promise<AgentToolResult<{ recorded: boolean; error?: string }>> => {
      const params = raw as Params;
      const label = params.label.trim();
      const themeKey = params.theme_key.trim().toLowerCase();
      const facets = [...new Set(params.facets.map((facet) => facet.trim().toLowerCase()).filter((facet) => facet !== ""))];
      if (wordCount(label) > 4) {
        return Promise.resolve({
          content: [{ type: "text", text: "Episode activity summary must contain at most four words." }],
          details: { recorded: false, error: "label_too_long" },
        });
      }
      if (!/^[a-z0-9][a-z0-9:_-]*$/i.test(themeKey)) {
        return Promise.resolve({
          content: [{ type: "text", text: "theme_key must be a compact lowercase identifier without spaces." }],
          details: { recorded: false, error: "invalid_theme_key" },
        });
      }
      if (input.dryRun !== true) {
        setPrivateLifeEpisodeSummary(input.db, input.episodeId, { label, themeKey, facets });
      }
      return Promise.resolve({
        content: [{ type: "text", text: `Private-life episode summarized: ${label}` }],
        details: { recorded: true },
      });
    },
  };
}
