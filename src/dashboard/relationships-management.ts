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
  getOverview: (input?: { userId?: string }) => RelationshipsOverview;
  reset: (input?: { userId?: string }) => RelationshipsOverview;
}

export interface RelationshipsOverview {
  profiles: RelationshipProfile[];
  selectedProfile: RelationshipProfile | null;
  events: ReturnType<typeof listRelationshipEvents>;
  promptPreview: string;
  config: {
    enabled: boolean;
    promptInjection: boolean;
    maxAxisDeltaPerSignal: number;
  };
}

function overview(db: Database, config: RelationshipConfig, selectedUserId?: string): RelationshipsOverview {
  const profiles = listRelationshipProfiles(db, 100);
  const selectedProfile = selectedUserId !== undefined
    ? profiles.find((profile) => profile.userId === selectedUserId) ?? null
    : profiles[0] ?? null;
  return {
    profiles,
    selectedProfile,
    events: listRelationshipEvents(db, { limit: 120, ...(selectedUserId !== undefined ? { userId: selectedUserId } : {}) }),
    promptPreview: renderRelationshipPromptContext({
      current: selectedProfile ?? undefined,
      currentLabel: selectedUserId ?? selectedProfile?.userId ?? "no user selected",
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
    getOverview: (params) => overview(input.db, configFor(input.getGuildConfig(), input.getGlobalConfig()), params?.userId),
    reset: (params) => {
      resetRelationships(input.db);
      return overview(input.db, configFor(input.getGuildConfig(), input.getGlobalConfig()), params?.userId);
    },
  };
}
