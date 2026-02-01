export {
  loadPersona,
  assembleSystemPrompt,
  formatChatHistory,
  type PromptContext,
  type ChatMessage,
} from "./prompt.ts";

export {
  shouldRespond,
  type TriggerInput,
  type TriggerResult,
} from "./triggers.ts";

export {
  createSendMessagesTool,
  type SendMessagesInput,
  type SendMessagesDetails,
  type MessageSender,
} from "./send-messages-tool.ts";

export {
  handleMessage,
  type IncomingMessage,
  type HandlerDeps,
  type HandleResult,
} from "./handler.ts";

export {
  computeDelay,
  createMultiMessageSender,
  type MessageDelayConfig,
  type ChannelActions,
} from "./multi-message.ts";

export { trimChatHistory } from "./context-trimming.ts";
