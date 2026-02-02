export {
  loadPersona,
  assembleSystemPrompt,
  formatChatHistory,
  TOOL_INSTRUCTIONS,
  type PromptContext,
  type ChatMessage,
} from "./prompt.ts";

export {
  assembleContext,
  contextToSystemPrompt,
  type ContextSection,
  type AssembledContext,
  type ContextAssemblyInput,
} from "./context-assembly.ts";

export {
  shouldRespond,
  type TriggerInput,
  type TriggerResult,
} from "./triggers.ts";

export {
  createSendMessageTool,
  type SendMessageInput,
  type SendMessageDetails,
  type MessageSender,
} from "./send-message-tool.ts";

export {
  handleMessage,
  type IncomingMessage,
  type HandlerDeps,
  type HandleResult,
} from "./handler.ts";

export { trimChatHistory } from "./context-trimming.ts";

export { createMemoryTools, type MemoryToolsDeps } from "./memory-tools.ts";

export { createSearchTool, type SearchToolDeps } from "./search-tool.ts";

export { createScheduleTool, type ScheduleToolDeps } from "./schedule-tool.ts";

export { createMemberListTool, type MemberListToolDeps, type MemberInfo } from "./member-list-tool.ts";

export { createChannelHistoryTool, type ChannelHistoryToolDeps, type ChannelMessage } from "./channel-history-tool.ts";

export { createBraveSearchTool, type BraveSearchToolDeps, type BraveSearchResult } from "./brave-search-tool.ts";
