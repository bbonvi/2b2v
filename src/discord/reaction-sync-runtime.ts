import type { Client, Message, MessageReaction, PartialMessage, PartialMessageReaction } from "discord.js";
import type { Database } from "../db/database";
import { deleteMessageEmojiReaction, deleteMessageReactions, upsertMessageReaction } from "../db/message-reactions";
import type { Logger } from "../logger";

function reactionEmojiIdentity(reaction: MessageReaction | PartialMessageReaction): { key: string; label: string } {
  const id = reaction.emoji.id;
  const name = reaction.emoji.name ?? id ?? "unknown";
  if (id !== null) return { key: `custom:${id}`, label: `:${name}:` };
  return { key: `unicode:${name}`, label: name };
}

async function fetchCompleteReaction(reaction: MessageReaction | PartialMessageReaction): Promise<MessageReaction | null> {
  if (!reaction.partial) return reaction;
  try {
    return await reaction.fetch();
  } catch {
    return null;
  }
}

export function registerReactionSyncRuntime(input: { client: Client; db: Database; log: Logger }): void {
  const { client, db, log } = input;

  async function processMessageReactionCount(
    reactionInput: MessageReaction | PartialMessageReaction,
    deleteOnFetchFailure = false,
  ): Promise<void> {
    const reaction = await fetchCompleteReaction(reactionInput);
    if (reaction === null && deleteOnFetchFailure) {
      processMessageReactionRemoveEmoji(reactionInput);
      return;
    }
    if (reaction === null) return;
    if (reaction.message.guildId === null) return;

    const { key, label } = reactionEmojiIdentity(reaction);
    upsertMessageReaction(db, {
      messageId: reaction.message.id,
      guildId: reaction.message.guildId,
      channelId: reaction.message.channelId,
      emojiKey: key,
      emojiLabel: label,
      count: reaction.count,
    });
  }

  function processMessageReactionRemoveEmoji(reaction: MessageReaction | PartialMessageReaction): void {
    if (reaction.message.guildId === null) return;
    const { key } = reactionEmojiIdentity(reaction);
    deleteMessageEmojiReaction(db, reaction.message.id, key, reaction.message.guildId);
  }

  function processMessageReactionRemoveAll(message: Message | PartialMessage): void {
    if (message.guildId === null) return;
    deleteMessageReactions(db, message.id, message.guildId);
  }

  client.on("messageReactionAdd", (reaction) => void (async () => {
    try {
      await processMessageReactionCount(reaction);
    } catch (err) {
      log.error("messageReactionAdd handler error", {
        messageId: reaction.message.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })());

  client.on("messageReactionRemove", (reaction) => void (async () => {
    try {
      await processMessageReactionCount(reaction, true);
    } catch (err) {
      log.error("messageReactionRemove handler error", {
        messageId: reaction.message.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })());

  client.on("messageReactionRemoveEmoji", (reaction) => {
    try {
      processMessageReactionRemoveEmoji(reaction);
    } catch (err) {
      log.error("messageReactionRemoveEmoji handler error", {
        messageId: reaction.message.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  client.on("messageReactionRemoveAll", (message) => {
    try {
      processMessageReactionRemoveAll(message);
    } catch (err) {
      log.error("messageReactionRemoveAll handler error", {
        messageId: message.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
