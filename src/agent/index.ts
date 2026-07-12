export {
  type ChatMessage,
} from "./prompt.ts";

export {
  assembleContext,
  contextToSystemPrompt,
  contextToSplitPrompts,
  SECTION_DEFS,
  type SectionRole,
  type SectionSource,
  type SectionDef,
  type ContextSection,
  type AssembledContext,
  type ContextAssemblyInput,
  type SplitPrompts,
} from "./context-assembly.ts";

export {
  shouldRespond,
  type TriggerInput,
  type TriggerResult,
} from "./triggers.ts";

export {
  handleMessage,
  type IncomingMessage,
  type HandlerDeps,
  type HandleResult,
  type MessageSender,
  type VoiceAttachment,
} from "./handler.ts";

export {
  parseResponseDirectives,
  renderSegmentsForMemory,
  type ResponseSegment,
} from "./response-directives.ts";

export { trimChatHistory } from "./context-trimming.ts";

export {
  buildMemoryContext,
  createRecordMemoryTool,
  extractAndApplyMemories,
  type MemoryContextInput,
  type MemoryExtractionInput,
  type RecordMemoryToolDeps,
} from "./memory-service.ts";

export { createSearchChannelMessagesTool, type SearchChannelMessagesToolDeps } from "./search-channel-messages-tool.ts";
export { createSearchAssetTool } from "./search-asset-tool.ts";

export {
  createScheduleTaskTool,
  createScheduleTools,
  createListScheduledTasksTool,
  createDeleteScheduledTaskTool,
  type ScheduleToolDeps,
} from "./schedule-tool.ts";

export { createChatUserListTool, type MemberListToolDeps, type MemberInfo } from "./member-list-tool.ts";

export { createChannelListTool, type ChannelListToolDeps, type ChannelInfo } from "./channel-list-tool.ts";

export { createEmojiListTool, buildEmojiListOutput, type EmojiListToolDeps } from "./emoji-list-tool.ts";

export {
  createDiscordRemoveUserTimeoutTool,
  createDiscordSetUserTimeoutTool,
  createDiscordTimeoutTools,
  type TimeoutMember,
  type TimeoutUserToolDeps,
} from "./timeout-user-tool.ts";

export { createMemoryListTool, createUserMemoryTool, type MemoryListToolDeps, type UserMemoryToolDeps } from "./user-memory-tool.ts";

export {
  createListChannelMessagesTool,
  type ListChannelMessagesToolDeps,
  type ListChannelMessage,
  type ListChannelMessagesInput,
  type ListChannelMessagesPage,
} from "./list-channel-messages-tool.ts";

export { createOwnMessageTools, type OwnMessageToolsDeps } from "./own-message-tool.ts";

export { createBraveSearchTool, type BraveSearchToolDeps, type BraveSearchResult } from "./brave-search-tool.ts";

export { createReadChatImagesTool, type ReadChatImagesToolDeps } from "./read-chat-images-tool.ts";

export {
  createReadUserAvatarTool,
  type AvatarSize,
  type ReadUserAvatarToolDeps,
  type ResolvedUserAvatar,
} from "./read-user-avatar-tool.ts";

export { createFetchImagesTool, type FetchImagesToolDeps } from "./fetch-images-tool.ts";

export {
  createCodexGenerateImageTool,
  type CodexGenerateImageToolDeps,
  type GeneratedImageAttachment,
} from "./codex-image-tool.ts";

export { fetchMissingReplyTargets, type ReplyFallbackDeps, type FetchedDiscordMessage } from "./reply-target-fallback.ts";

export { createFetchUrlTool, type FetchUrlToolDeps } from "./fetch-url-tool.ts";

export { createSummarizeVideoTool, type SummarizeVideoToolDeps } from "./summarize-video-tool.ts";

export { createStartThreadTool, type StartThreadToolDeps, type StartThreadDetails } from "./start-thread-tool.ts";

export {
  createReactToMessageTool,
  normalizeReactToMessageInput,
  type ReactToMessageToolDeps,
  type ReactToMessageDetails,
} from "./react-to-message-tool.ts";
