import { join } from 'node:path';

import type { Context } from 'grammy';
import type { ParseMode } from 'grammy/types';

import type { Config } from '../config.ts';
import type { Db } from '../db/database.ts';
import type { Logger } from '../log/logger.ts';
import { accessText, allow, deny, setPolicy } from './commands/allowlist.ts';
import { auditText } from './commands/audit.ts';
import { healthText, type TurnState } from './commands/health.ts';
import { logQuotes } from './commands/logs.ts';
import type { CommandHandler } from './dispatcher.ts';

export interface CommandDeps {
  config: Pick<Config, 'ownerId' | 'accessPath' | 'dataDir' | 'memoriesDir' | 'logDir'>;
  db: Db;
  engine: TurnState & {
    stashRestoreContext(reason: string): void;
    resetSession(): Promise<void>;
  };
  /** The dispatcher's switch: while paused, every inbound message is dropped. */
  pause: { paused: boolean };
  /** `tars.telegram`. */
  log: Logger;
  /** What `/kill` triggers once the owner has been answered: a clean shutdown, exit code 0. */
  kill(): void;
}

type Command = (ctx: Context, args: string[]) => Promise<void>;

const RESET_REPLY =
  'Session cleared — Claude restarted with a fresh context. Chat history and memories are preserved; ' +
  'a short recap of recent messages will be carried into the next turn.';

/**
 * The owner commands. Any of these 11 is consumed whoever sends it, wherever
 * (no access gate, no pause, never reaches the model) and only the owner gets
 * an answer; any other `/word` is left to the message pipeline.
 */
export function createCommands(deps: CommandDeps): CommandHandler {
  const { config, db, engine, log } = deps;
  const commands = new Map<string, Command>([
    ['kill', (ctx) => kill(ctx, deps)],
    ['reset_session', (ctx) => resetSession(ctx, deps)],
    ['pause', (ctx) => pause(ctx, deps)],
    ['resume', (ctx) => resume(ctx, deps)],
    ['health', (ctx) => reply(ctx, healthText(db, engine, deps.pause.paused), 'Markdown')],
    ['audit', (ctx) => reply(ctx, auditText(db, config), 'Markdown')],
    ['logs', (ctx, args) => logs(ctx, join(config.logDir, 'tars.log'), args)],
    ['allow', (ctx, args) => reply(ctx, allow(config.accessPath, args, log))],
    ['deny', (ctx, args) => reply(ctx, deny(config.accessPath, args, log))],
    ['policy', (ctx, args) => reply(ctx, setPolicy(config.accessPath, args, log))],
    ['access', (ctx) => reply(ctx, accessText(config.accessPath, config.ownerId, log))],
  ]);
  return async (ctx, { name, args }) => {
    const command = commands.get(name);
    if (!command) return false;
    if (ctx.from?.id === config.ownerId) await command(ctx, args);
    return true;
  };
}

async function kill(ctx: Context, deps: CommandDeps): Promise<void> {
  deps.log.warn('/kill received from owner; shutting down');
  // Best effort: a goodbye that fails to send must not keep the bot running.
  await reply(ctx, 'Shutting down…').catch(() => undefined);
  deps.kill();
}

async function resetSession(ctx: Context, deps: CommandDeps): Promise<void> {
  deps.log.warn('/reset_session received from owner; respawning cc with a fresh session');
  deps.engine.stashRestoreContext('owner-reset');
  await deps.engine.resetSession();
  // The reset is done; an acknowledgement that fails to send must not read as a failed reset.
  await reply(ctx, RESET_REPLY).catch(() => undefined);
}

async function pause(ctx: Context, deps: CommandDeps): Promise<void> {
  deps.pause.paused = true;
  deps.log.warn('/pause received from owner; dropping inbound messages');
  await reply(ctx, '⏸ paused — messages dropped until /resume');
}

async function resume(ctx: Context, deps: CommandDeps): Promise<void> {
  deps.pause.paused = false;
  deps.log.warn('/resume received from owner; forwarding inbound messages');
  await reply(ctx, '▶ resumed');
}

async function logs(ctx: Context, path: string, args: string[]): Promise<void> {
  const quotes = logQuotes(path, args);
  if (!quotes.length) return reply(ctx, 'no logs yet');
  for (const quote of quotes) await reply(ctx, quote, 'HTML');
}

/**
 * Answer in the command's chat: quoting the command in groups (not in DMs),
 * inside its forum topic.
 */
async function reply(ctx: Context, text: string, parseMode?: ParseMode): Promise<void> {
  const msg = ctx.msg;
  const quote = msg && msg.chat.type !== 'private' ? { reply_parameters: { message_id: msg.message_id } } : {};
  await ctx.reply(text, parseMode ? { ...quote, parse_mode: parseMode } : quote);
}
