import type { Database } from "../db/database";
import type { GlobalConfig, GuildConfig, RelationshipConfig } from "../config/types";
import {
  listRelationshipEvents,
  listRelationshipProfiles,
  renderRelationshipPromptContext,
  resetRelationships,
  type RelationshipProfile,
} from "../relationships";

function configFor(guildConfig: GuildConfig, globalConfig: GlobalConfig): RelationshipConfig {
  const config = guildConfig.relationships ?? globalConfig.defaultRelationships;
  if (config === undefined) throw new Error("relationships are not configured");
  return config;
}

export interface RelationshipsManagementApi {
  getOverview: () => RelationshipsOverview;
  reset: () => RelationshipsOverview;
}

export interface RelationshipsOverview {
  profiles: RelationshipProfile[];
  events: ReturnType<typeof listRelationshipEvents>;
  promptPreview: string;
  config: {
    enabled: boolean;
    promptInjection: boolean;
    maxAxisDeltaPerSignal: number;
  };
}

function overview(db: Database, config: RelationshipConfig): RelationshipsOverview {
  const profiles = listRelationshipProfiles(db, 100);
  return {
    profiles,
    events: listRelationshipEvents(db, { limit: 120 }),
    promptPreview: renderRelationshipPromptContext({
      current: profiles[0],
      currentLabel: profiles[0]?.userId ?? "no user selected",
    }),
    config: {
      enabled: config.enabled,
      promptInjection: config.promptInjection,
      maxAxisDeltaPerSignal: config.maxAxisDeltaPerSignal,
    },
  };
}

export function createRelationshipsManagementApi(input: {
  db: Database;
  getGlobalConfig: () => GlobalConfig;
  getGuildConfig: () => GuildConfig;
}): RelationshipsManagementApi {
  return {
    getOverview: () => overview(input.db, configFor(input.getGuildConfig(), input.getGlobalConfig())),
    reset: () => {
      resetRelationships(input.db);
      return overview(input.db, configFor(input.getGuildConfig(), input.getGlobalConfig()));
    },
  };
}
