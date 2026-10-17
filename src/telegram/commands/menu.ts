import type { Api } from 'grammy';

import type { Logger } from '../../log/logger.ts';

/** The owner's `/` menu, in display order. */
const MENU = [
  { command: 'health', description: 'quick health readout' },
  { command: 'audit', description: 'recent failures, backups, memory footprint' },
  { command: 'logs', description: 'tail recent log lines: /logs [N]' },
  { command: 'access', description: 'show access policy' },
  { command: 'allow', description: 'add to allowlist: /allow <user|group> <id>' },
  { command: 'deny', description: 'remove from allowlist: /deny <user|group> <id>' },
  { command: 'policy', description: 'set policy: /policy <owner_only|allowlist|open>' },
  { command: 'pause', description: 'drop inbound messages until /resume' },
  { command: 'resume', description: 're-enable message forwarding' },
  { command: 'kill', description: 'stop the bot' },
  { command: 'reset_session', description: 'fresh Claude session (history kept)' },
];

/**
 * Show the owner commands in the owner's own chat only (nobody else gets a
 * menu). Run at startup before polling; a failure is logged and startup goes on.
 */
export async function registerCommandMenu(api: Api, ownerId: number, log: Logger): Promise<void> {
  try {
    await api.setMyCommands(MENU, { scope: { type: 'chat', chat_id: ownerId } });
  } catch (err) {
    log.error('failed to register owner-scoped bot commands', { err });
  }
}
