export type RelationshipVisibility = "source-bound" | "relationship-private" | "private-internal";
export type RelationshipEventSource = "llm" | "admin" | "system";

export interface RelationshipScope {
  guildId?: string;
  channelId?: string;
  userId?: string;
  sourceMessageId?: string;
}

export type RelationshipAxis =
  | "familiarity"
  | "trust"
  | "warmth"
  | "respect"
  | "tension"
  | "curiosity"
  | "attraction"
  | "intimacy"
  | "attachment";

export type RelationshipAxes = Record<RelationshipAxis, number>;

export interface RelationshipProfile {
  userId: string;
  axes: RelationshipAxes;
  notes: string[];
  boundaries: string[];
  openLoops: string[];
  recent: RelationshipMoment[];
  updatedAt: number;
}

export interface RelationshipMoment {
  id: string;
  at: number;
  summary: string;
  visibility: RelationshipVisibility;
  scope?: RelationshipScope;
}

export interface RelationshipEvent {
  id: string;
  type: "relationship_signal";
  at: number;
  source: RelationshipEventSource;
  visibility: RelationshipVisibility;
  guildId: string | null;
  channelId: string | null;
  userId: string | null;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface RelationshipSignalInput {
  userId?: string;
  summary: string;
  confidence: number;
  visibility?: RelationshipVisibility;
  axes?: Partial<Record<RelationshipAxis, number>>;
  /** Reverse a still-unrepaired part of recent opposing axis movement. */
  repair?: boolean;
  note?: string;
  boundary?: string;
  removeBoundary?: string;
  openLoop?: string;
  closeOpenLoop?: string;
}

export interface RelationshipConfig {
  /** Named model profile used by relationship maintenance. */
  modelProfile: string;
  enabled: boolean;
  promptInjection: boolean;
  priorExchanges: PriorExchangesConfig;
  maxAxisDeltaPerSignal: number;
  maxToolCalls: number;
}

export interface PriorExchangesConfig {
  enabled: boolean;
  maxExchanges: number;
  maxMessageChars: number;
  refreshMinutes: number;
}

export type RelationshipConfigYaml = Partial<Omit<RelationshipConfig, "priorExchanges">> & {
  priorExchanges?: Partial<PriorExchangesConfig>;
};
