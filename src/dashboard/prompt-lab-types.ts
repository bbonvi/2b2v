export interface PromptLabDraftMessage {
  id: string;
  text: string;
  reply: boolean;
  channelId?: string;
  replyToMessageId?: string;
  attachments: string[];
  voice: boolean;
}

export interface PromptLabDryRun {
  tool: string;
  args: unknown;
}

export interface PromptLabRelationshipDryRun {
  requestId: string;
  signals: unknown[];
  accepted: unknown[];
  rejected: unknown[];
}

export interface PromptLabMemoryDryRun {
  requestId?: string;
  enabled: boolean;
  ran: boolean;
  error?: string;
}

export interface PromptLabRunResult {
  requestId: string;
  triggered: boolean;
  responseText?: string;
  drafts: PromptLabDraftMessage[];
  dryRuns: PromptLabDryRun[];
  relationshipsContext?: string;
  relationshipsExtraction?: PromptLabRelationshipDryRun;
  memoryExtraction?: PromptLabMemoryDryRun;
  toolCount: number;
  llmCallCount: number;
  estimatedCostUsd: number | null;
  totalDurationMs: number;
  error?: string;
}
