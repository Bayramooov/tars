import { join } from 'node:path';

import type { InputFile } from 'grammy';

import { type Db, openDatabase } from '../../../src/db/database.ts';
import { insertMessage } from '../../../src/db/messages.ts';
import { Transcript } from '../../../src/log/transcript.ts';
import type { Tool, ToolResult } from '../../../src/mcp/tool.ts';
import { createBot } from '../../../src/telegram/bot.ts';
import { FakeTelegram } from '../../fakes/telegram.ts';
import { memoryLogger } from '../../helpers/log.ts';
import { tempDir } from '../../helpers/tmp.ts';

/** A tool context on the fake Bot API and a fresh database; chat 111 is titled "Ali"; `replied` collects typing stops. */
export function toolContext() {
  const fake = new FakeTelegram();
  const bot = createBot('1:t', { network: fake.transformer, botInfo: fake.botInfo });
  const log = memoryLogger();
  const db = openDatabase(join(tempDir(), 'h.db'), log);
  const replied: number[] = [];
  const ctx = {
    api: bot.api,
    me: () => fake.botInfo,
    db,
    chatTitles: new Map([[111, 'Ali']]),
    transcript: new Transcript(log, 'compact'),
    log,
    onChatReplied: (chatId: number) => void replied.push(chatId),
  };
  return { fake, db, log, replied, ctx };
}

/** Call a tool the way the MCP server does: arguments validated, defaults filled in. */
export const call = (tool: Tool, args: Record<string, unknown>): Promise<ToolResult> => tool.run(tool.args.parse(args));

/** A stored outbound message the tools can act on. */
export function seedMessage(db: Db, chatId: number, messageId: number, text = 'hi'): void {
  insertMessage(db, { chatId, messageId, userId: 999, direction: 'out', timestamp: new Date(), text });
}

export const messageRow = (db: Db, chatId: number, messageId: number) =>
  db.prepare('SELECT * FROM messages WHERE chat_id=? AND message_id=?').get(chatId, messageId) as Record<string, unknown> | undefined;

/** The bytes an `InputFile` upload would send. */
export async function uploaded(file: unknown): Promise<string> {
  const raw = (await (file as InputFile).toRaw()) as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  for await (const chunk of raw) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}
