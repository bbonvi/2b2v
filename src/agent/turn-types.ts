import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AssembledContext } from "./context-assembly.ts";
import type { AssetRef } from "./asset-id.ts";
import type { HistoryAsset } from "./history-types.ts";
import type { RuntimePromptBundle } from "../config/instruction-bundle.ts";
import type { GlobalConfig, GuildConfig, LlmProvider, PromptCachingConfig, PromptTransportRole, ProviderPromptTransportConfig } from "../config/types.ts";
import type { Logger, RequestLog } from "../logger.ts";
import type { ModelImageInputSupport } from "../llm/client.ts";
import type { OpenRouterChatRequest, OpenRouterChatResult, OpenRouterMessage } from "../llm/types.ts";
import type { StablePromptSection } from "./prompt-cache.ts";
import type { TriggerResult } from "./triggers.ts";
import type { TtsResult } from "../tts/types.ts";

export interface IncomingMessage {
  content: string;
  guildId?: string;
  guildName?: string;
  channelId?: string;
  channelName?: string;
  authorId: string;
  authorUsername: string;
  authorDisplayName?: string;
  authorGlobalName?: string;
  authorIsBot?: boolean;
  botUserId: string;
  mentionedUserIds: string[];
  mentionedRoleIds: string[];
  botRoleIds: string[];
  mentionedEveryone: boolean;
  translatedContent: string;
  /** Render this synthetic current turn as its literal content, without Discord event wrappers. */
  bareCurrentTurn?: boolean;
  /** The canonical chat-history section already contains this Discord content. */
  currentContentInHistory?: boolean;
  /** Full visible current-turn event text, including debounced same-author followups. */
  eventContent?: string;
  /** Voice and other non-message turns can replace Discord-message prompt headings. */
  eventPrompt?: {
    metadataHeading: string;
    contentHeading: string;
    metadataText?: string;
  };
  messageId?: string;
  replyToMessageId?: string;
  repliedToBot?: boolean;
  repliedToBotRouteSource?: {
    sourceGuildId: string;
    sourceChannelId: string;
    sourceMessageId: string;
    /** Stored private context omitted when the routed message is already in history. */
    handoff?: string;
  };
  imageInputs?: CurrentTurnImageInput[];
  /** Lazy assets attached to the current Discord event. */
  assets?: HistoryAsset[];
}

export type ChatCompleteFn = (request: OpenRouterChatRequest) => Promise<OpenRouterChatResult>;

export interface MaintenancePromptContext {
  provider: LlmProvider;
  model: string;
  transport: ProviderPromptTransportConfig;
  stableSections: StablePromptSection[];
  initialRoles: PromptTransportRole[];
  sessionId?: string;
  promptCacheKey?: string;
  promptCaching: PromptCachingConfig;
  /** Exact provider-visible tool contract from the actor turn that maintenance must preserve. */
  toolContractSignature?: string;
  /** Active tool names in provider order, including transcript-deferred additions. */
  activeToolNames?: string[];
  /** Skills loaded in this actor transcript. */
  loadedSkillIds?: string[];
}

/** Durable continuation state for a long-running actor invocation. */
export interface ActorContinuation {
  transcript?: OpenRouterMessage[];
  controlMessage: string;
  loadedSkillIds?: readonly string[];
  takePendingMessages?: () => OpenRouterMessage[] | Promise<OpenRouterMessage[]>;
  maxToolCalls: number | null;
  wallClockTimeoutMs: number;
  compaction: { reserveTokens: number; keepRecentTokens: number };
}

export interface MemoryExtractionRequest {
  sourceMessageId?: string;
  userMessage: string;
  assistantReply: string;
  recentContext: string;
  context: AssembledContext;
  incomingMessage: IncomingMessage;
  visibleReplySent: boolean;
  maintenanceTranscript?: OpenRouterMessage[];
  availableTools?: AgentTool[];
  promptContext?: MaintenancePromptContext;
}

export interface IgnoredReplyRequest {
  sourceMessageId?: string;
  channelId?: string;
  historyText: string;
  rawResponse: string;
}

/** Return true when a completed turn has enough material for maintenance passes. */
export function hasMaintenanceMaterial(input: Pick<MemoryExtractionRequest, "userMessage" | "assistantReply">): boolean {
  return input.userMessage.trim() !== "" || input.assistantReply.trim() !== "";
}

export interface SilentMemoryAgentInput {
  globalConfig: GlobalConfig;
  guildConfig: GuildConfig;
  context: AssembledContext;
  systemPrompt?: string;
  personaPrompt?: string;
  runtimePrompts?: RuntimePromptBundle;
  incomingMessage: IncomingMessage;
  userContent: string;
  assistantReply: string;
  visibleReplySent: boolean;
  passKind?: "post_reply" | "ambient";
  visibleUserMemoryContext?: string;
  tools: AgentTool[];
  transcript?: OpenRouterMessage[];
  promptContext?: MaintenancePromptContext;
  log?: Logger;
  requestLog?: RequestLog;
  completeChat?: ChatCompleteFn;
  signal?: AbortSignal;
  /** Cache the current pass input because another maintenance pass will consume it. */
}

export interface SilentToolAgentInput {
  globalConfig: GlobalConfig;
  guildConfig: GuildConfig;
  context: AssembledContext;
  systemPrompt?: string;
  personaPrompt?: string;
  runtimePrompts?: RuntimePromptBundle;
  incomingMessage: IncomingMessage;
  userContent: string;
  assistantReply: string;
  visibleReplySent: boolean;
  visibleUserMemoryContext?: string;
  tools: AgentTool[];
  runtimeInstruction: string;
  controlMessage: string;
  /** Named model execution policy for this private maintenance pass. */
  modelProfile?: string;
  /** Null removes background tool-call and round caps. */
  maxToolCalls?: number | null;
  wallClockTimeoutMs?: number;
  /** End after a complete tool round containing these mutations unless any tool result needs repair. */
  terminateAfterSuccessfulToolRoundNames?: readonly string[];
  transcript?: OpenRouterMessage[];
  promptContext?: MaintenancePromptContext;
  log?: Logger;
  requestLog?: RequestLog;
  completeChat?: ChatCompleteFn;
  signal?: AbortSignal;
  /** Cache the current pass input because another maintenance pass will consume it. */
}

/** Attachment data for a generated voice message. */
export interface VoiceAttachment {
  buffer: Buffer;
  filename: string;
  contentType: string;
  historyText?: string;
}

/** Binary attachment queued for an outgoing Discord message. */
export interface OutboundAttachment {
  id: string;
  buffer: Buffer;
  filename: string;
  contentType: string;
  /** Send this Discord sticker ID natively; the file fields remain its fallback. */
  stickerId?: string;
  /** Permanent chat asset that supplied these bytes when this is a repost. */
  sourceAssetId?: number;
  requestedSize?: string;
  actualSize?: string;
  transport?: string;
  is4k?: boolean;
}

/** Image bytes attached to the current synthetic or live turn for native model vision. */
export interface CurrentTurnImageInput {
  buffer: Buffer;
  contentType: string;
  metadataText?: string;
}

/** Optional Discord-native presentation for a visible message. */
export interface MessagePresentation {
  kind: "components_v2_card";
  accentColor?: number;
  /** Stable component identity used to recognize structured cards received from another bot. */
  componentId?: number;
  /** Prompt representation stored instead of the visible card text. */
  history?: {
    text: string;
  };
}

/** Callback that performs the actual Discord send. */
export type MessageSender = (
  text: string,
  reply: boolean,
  channelId: string | undefined,
  voice?: VoiceAttachment,
  signal?: AbortSignal,
  replyToMessageId?: string,
  attachments?: OutboundAttachment[],
  dedupeKey?: string,
  presentation?: MessagePresentation,
) => Promise<{
  sentMessageId: string;
  sentGuildId?: string;
  sentChannelId?: string;
  warnings?: string[];
}>;

/** Resolves stored chat asset IDs into Discord-ready file attachments. */
export type AssetAttachmentResolver = (assetIds: AssetRef[]) => Promise<OutboundAttachment[]>;

/** Optional streamed response transport used by live voice instead of Discord text dispatch. */
export interface ExternalResponseSink {
  startModelTurn: () => void;
  push: (delta: string) => Promise<boolean>;
  finish: (finalText: string) => Promise<{ visible: boolean; memoryText: string; malformed: boolean }>;
  abort: (userId?: string) => void;
}

/** Dependencies injected into the handler. No direct discord.js coupling. */
export interface HandlerDeps {
  globalConfig: GlobalConfig;
  guildConfig: GuildConfig;
  context: AssembledContext;
  /** Discord channel/thread that initiated this reply loop. */
  currentChannelId?: string;
  systemPrompt?: string;
  personaPrompt?: string;
  runtimePrompts?: RuntimePromptBundle;
  sender: MessageSender;
  /** Native OpenRouter tools exposed to the model. */
  extraTools?: AgentTool[];
  /** Caller-owned extension tools that must be visible without discovery. */
  initialToolNames?: readonly string[];
  /** Caller-preloaded skill prose and execution grants for this fresh turn. */
  loadedSkillIds?: readonly string[];
  log?: Logger;
  onTriggered?: (result: NonNullable<TriggerResult>) => void;
  /** Called when work continues after a user-visible message so typing can be sent before later output. */
  onStillWorking?: (channelId: string | undefined) => void | Promise<void>;
  /** Timestamp when the current typing indicator loop started, or 0 when inactive. */
  getTypingStartedAt?: () => number;
  /** Called after user-visible output starts so continuous background typing can stop. */
  onVisibleOutput?: () => void;
  /** Called when the model produces its first complete visible message or tool call. */
  onActionCommitted?: () => void;
  /** Reports public output produced directly by a state-changing tool in this reply loop. */
  hasExternalVisibleOutput?: () => boolean;
  /** Minimum visible typing time before a buffered streamed follow-up message is sent. */
  liveMessageTypingHoldMs?: number;
  onAgentEnd?: () => void;
  requestLog?: RequestLog;
  ttsEnabled?: boolean;
  generateSpeech?: (text: string) => Promise<TtsResult>;
  forceTrigger?: boolean;
  triggerOverride?: NonNullable<TriggerResult>;
  completeChat?: ChatCompleteFn;
  afterReply?: (request: MemoryExtractionRequest) => Promise<void>;
  /** Registers fire-and-forget maintenance so coordinated shutdown can await it. */
  trackBackgroundTask?: (task: Promise<void>) => void;
  /** Persists prompt-only assistant traces such as ignored replies. */
  onIgnoredReply?: (request: IgnoredReplyRequest) => void | Promise<void>;
  /** Live metadata result for the selected model profile. Unknown means try native image input first. */
  modelImageInputSupport?: ModelImageInputSupport;
  /** Consume generated image attachments by opaque IDs returned from image tools. */
  consumeGeneratedAttachments?: (ids: string[]) => OutboundAttachment[];
  /** Resolves asset_ids on <message> envelopes into outgoing Discord attachments. */
  resolveAssetAttachments?: AssetAttachmentResolver;
  /** Persists private context after the routed Discord message exists. */
  onHandoffDelivered?: (input: {
    handoff: string;
    routedMessageId: string;
    destinationGuildId: string;
    destinationChannelId: string;
  }) => void | Promise<void>;
  /** Disable streamed Discord sends so callers can re-check state before final delivery. */
  disableLiveOutput?: boolean;
  /** Replace normal text/voice directive dispatch with a live external stream. */
  externalResponseSink?: ExternalResponseSink;
  /** Named model execution policy override for specialized visible turns such as live voice. */
  modelProfile?: string;
  /** Overrides model retry delays for deterministic tests. Production callers should omit this. */
  modelTurnRetryDelayMs?: (attempt: number) => number;
  /** Optional caller cancellation, used for voice barge-in and session departure. */
  abortSignal?: AbortSignal;
  /** Called immediately before final visible sends; false drops the reply as stale. */
  preSendCheck?: (draftText: string) => boolean | Promise<boolean>;
  scheduledTaskRun?: boolean;
  /** Run the same actor loop as a durable background continuation. */
  actorContinuation?: ActorContinuation;
}

export interface HandleResult {
  triggered: boolean;
  triggerResult: TriggerResult;
  agentRan: boolean;
  responseText?: string;
  /** Authored private monologue from complete `<thoughts>` blocks. */
  privateThoughts?: string[];
  maintenanceTranscript?: OpenRouterMessage[];
  availableTools?: AgentTool[];
  promptContext?: MaintenancePromptContext;
}
