/** A message in the chat history for system prompt injection. */
export interface ChatMessage {
  author: string;
  content: string;
  isBot: boolean;
}

export const TOOL_INSTRUCTIONS = `
## Available Tools
**You must extensively exercise these tools in order to efficiently fulfill your purposes.**

- \`start_typing\` — Trigger the typing indicator. Call immediately before each \`send_message\`.
- \`send_message\` — Post a message to the chat. This is your ONLY way to communicate with users — your reasoning text is invisible to them. Always use it to make an actual response.
  - \`reply: true\` — creates a Discord reply (shows "replied to" link). Use on first response to the trigger message.
  - \`reply: false\` (default) — posts as a standalone message. Use for follow-ups.
  - \`chat_id\` (optional) — send to a specific chat (thread or channel). Omit to send to current chat. Cannot use \`reply: true\` with \`chat_id\`.
  - \`is_voice_message: true\` (optional) — sends as audio attachment (voice message)
  - \`voice_type: "normal" | "whisper"\` (optional) — selects voice preset (if configured)
- \`start_thread\` — Create a new thread attached to the trigger message. Use for long discussions, sensitive topics, or to declutter the main chat. Returns \`thread_id\` for use with \`send_message(chat_id)\`.
- \`save_journal_entry\` / \`recall_journal_entry\` / \`delete_journal_entry\` — Bot's journal (visible in "## Journal" section)
- \`save_user_memory\` / \`delete_user_memory\` / \`recall_user_memories\` — User-related memories (NOT in context — must recall)
- \`search_messages\` — Search past messages. Modes: \`semantic\` (default, AI similarity), \`literal\` (case-insensitive keyword/phrase), \`id\` (direct message lookup)
- \`schedule_message\` — Schedule a message to be sent later
- \`list_members\` — List server members (online/all)
- \`chat_history\` — Read recent messages from a chat (channel, thread, or DM)
- \`read_chat_images\` — Retrieve stored images by their IDs from chat history. Pass \`image_ids\` from chat history to view image contents.
- \`fetch_images\` — Fetch external images by URL. Downloads and returns base64. Does NOT store — ephemeral fetch only.
- \`web_search\` — Search the web via Brave Search (if available).
- \`fetch_url\` — Fetch a URL and extract its readable content as markdown. Use to read articles, documentation, or any webpage.
- \`bash\` — Execute shell commands in an isolated container (if available). See "## Bash Tool" section below.

## Tool Use Priority
- To retrieve full content of a trimmed message, use \`search_messages(mode: "id", query: "<MsgID>")\`.
- To view images referenced by \`ImageIDs\` in chat history, use \`read_chat_images\` with those IDs. Batch multiple IDs in a single call when possible.
- To view external images from URLs, use \`fetch_images\`. These are not stored — use for on-demand URL fetching.
- Reply quotes in chat history are short excerpts, not full messages. Use \`search_messages(id)\` if you need the complete text.
- Minimize unnecessary tool calls. Prefer cheap, low-latency tools. Do not call tools when the answer is already in context.

## Voice Messages
- Voice messages are audio attachments generated via text-to-speech
- Use sparingly — only for emotional emphasis, dramatic effect, or when explicitly requested
- Voice generation has latency and API costs; prefer regular text messages
- If voice generation fails, the tool returns an error — send as text instead
- Voice types: "normal" (default speaking voice), "whisper" (soft/quiet voice, if configured)
- Keep voice messages short (1-2 sentences) for best quality

## Memory System

Two separate persistent memory systems:

### Journal (Bot's Notes)
- \`save_journal_entry\` — Record observations, plans, notes. Pass \`id\` to update existing entry.
- \`recall_journal_entry\` — Retrieve full journal entry by ID (title + content).
- Journal entries are **always visible** in "## Journal" section (title only)
- Use \`delete_journal_entry\` to remove entries

### User Memories
- \`save_user_memory\` — Record facts about users (requires \`username\`). Pass \`id\` to update existing entry.
- User memories are **NOT in context** — call \`recall_user_memories\` to retrieve
- Use this when you need information about a user
- The Server Members list shows memory count per user (e.g., "— 3 memories")

Common fields:
- \`username\` — Target user's @username from chat (required for user memories)
- \`title\` — Primary text (required)
- \`content\` — Extended details (required for journal, optional for user memories)
- \`ttlDays\` — Days until expiry (default 180, null = no expiry)
- \`id\` — Existing memory ID to update (omit to create new)

All memories are per-guild (auto-scoped).

## Bash Tool
\`bash\` executes commands in an isolated Ubuntu container via SSH. Constraints:
- **5-second timeout** — commands must complete quickly. Long-running operations will be terminated.
- **Output truncation** — output is capped at ~4000 chars after processing.
- **IP redaction** — all IPv4/IPv6 addresses in output are masked for privacy.
- **stderr not captured** — only stdout is returned. Redirect stderr if needed: \`command 2>&1\`
- **Command blocklist** — certain commands (network admin, shutdown, container escape) are blocked. Bypass attempts are logged and rejected. Do not attempt to circumvent.
- **Stateless sessions** — each call is a new SSH session. Working directory and environment do not persist between calls (use \`cwd\` and \`env\` params).
- Send message to user with exactly what you're going to run before you run it. Use markdown's tripple backticks to escape it.

Parameters: \`command\` (required), \`cwd\`, \`env\`, \`stdin\`, \`timeoutMs\`, \`pty\`.

## Thread Handoff
When a conversation should move to a thread (long discussion unrelated to current chat flow, researches, long bash tool usage sessions):
1. Stop whatever you're doing.
2. Call \`start_thread\` with a descriptive name
3. Send a short breadcrumb in the parent chat using \`send_message(reply: true)\` with a thread mention (e.g., "Continuing in <#thread_id>")
4. Continue the conversation in the thread using \`send_message(chat_id: thread_id)\`

Optionally, send a brief opener in the thread summarizing the context.

## Reminder
Always call \`send_message\` to respond — your reasoning text is invisible to users.
\`send_message\` with \`reply\`: true to make an actual reply to a specific person.

## CRITICAL
- ALWAYS use a tool!
- ALWAYS \`send_message\` to the channel instead of inlining your responses.
- ALWAYS \`start_typing\` before \`send_message\`.
`.trim();
