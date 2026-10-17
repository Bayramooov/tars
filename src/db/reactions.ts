import type { Db } from './database.ts';
import type { MessageKey } from './messages.ts';

type Reactions = Map<string, number[]>;

/** A user's reaction change: drop them from the old emojis, add them to the new ones. */
export function applyUserReaction(db: Db, key: MessageKey, change: { userId: number; oldEmoji: string[]; newEmoji: string[] }): void {
  const reactions = load(db, key);
  for (const emoji of change.oldEmoji) {
    const users = (reactions.get(emoji) ?? []).filter((u) => u !== change.userId);
    if (users.length) reactions.set(emoji, users);
    else reactions.delete(emoji);
  }
  for (const emoji of change.newEmoji) {
    const users = reactions.get(emoji) ?? [];
    if (!users.includes(change.userId)) reactions.set(emoji, [...users, change.userId]);
  }
  store(db, key, reactions);
}

/** The bot's reaction replaces any earlier one of its own (a bot has one reaction per message). */
export function addBotReaction(db: Db, key: MessageKey, botUserId: number, emoji: string): void {
  const reactions = load(db, key);
  for (const [e, users] of reactions) reactions.set(e, users.filter((u) => u !== botUserId));
  reactions.set(emoji, [...(reactions.get(emoji) ?? []), botUserId]);
  store(db, key, reactions);
}

/** `messages.reactions`: `{"👍": [user ids]}`, emoji order kept, NULL when empty. */
function load(db: Db, [chatId, messageId]: MessageKey): Reactions {
  const raw = db.prepare('SELECT reactions FROM messages WHERE chat_id=? AND message_id=?').pluck().get(chatId, messageId) as string | null | undefined;
  try {
    const data: unknown = JSON.parse(raw ?? '{}');
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return new Map();
    return new Map(Object.entries(data).flatMap(([emoji, users]) => (Array.isArray(users) ? [[emoji, users as number[]] as const] : [])));
  } catch {
    return new Map();
  }
}

function store(db: Db, [chatId, messageId]: MessageKey, reactions: Reactions): void {
  const kept = [...reactions].filter(([, users]) => users.length);
  const payload = kept.length ? JSON.stringify(Object.fromEntries(kept)) : null;
  db.prepare('UPDATE messages SET reactions=? WHERE chat_id=? AND message_id=?').run(payload, chatId, messageId);
}
