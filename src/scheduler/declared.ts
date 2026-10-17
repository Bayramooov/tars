import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { isValidCron } from './cron.ts';

/** Seed-key namespace of `default-reminders.json` rows; the self-reflection key never matches it. */
export const KEY_PREFIX = 'committed:';

/** One validated entry of `default-reminders.json`. */
export interface DeclaredReminder {
  name: string;
  cron: string;
  text: string;
  /** `"owner"` resolved to the owner's id. */
  chatId: number;
  enabled: boolean;
  /** `committed:<name>:<hash of cron, text and chat>` — an edit changes it, so the boot reconcile re-seeds. */
  key: string;
}

/** The operator's mistake in `default-reminders.json`; boot fails rather than silently drop a reminder. */
const configError = (message: string) => Object.assign(new Error(message), { name: 'ReminderConfigError' });

/**
 * Parse and validate the git-tracked `default-reminders.json`. A missing
 * file declares nothing. Throws `ReminderConfigError` on malformed input.
 */
export function loadDeclaredReminders(path: string, ownerId: number): DeclaredReminder[] {
  if (!existsSync(path)) return [];
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw Object.assign(configError(`${path} is not valid JSON: ${(err as Error).message}`), { cause: err });
  }
  if (!isObject(data)) throw configError(`${path}: top level must be a JSON object`);
  const entries = 'reminders' in data ? data.reminders : [];
  if (!Array.isArray(entries)) throw configError(`${path}: 'reminders' must be a list`);
  const reminders = entries.map((raw: unknown, i) => parseEntry(raw, `reminders[${i}]`, ownerId));
  const names = new Set<string>();
  for (const { name } of reminders) {
    if (names.has(name)) throw configError(`${path}: duplicate reminder name ${JSON.stringify(name)}`);
    names.add(name);
  }
  return reminders;
}

function parseEntry(raw: unknown, where: string, ownerId: number): DeclaredReminder {
  if (!isObject(raw)) throw configError(`${where} must be an object`);
  const name = requireText(raw, 'name', where);
  const cron = requireText(raw, 'cron', where);
  const text = reminderText(raw.text, where);
  if (!isValidCron(cron)) throw configError(`${where}: invalid cron expression ${JSON.stringify(cron)}`);
  const chat = 'chat' in raw ? raw.chat : 'owner';
  if (chat !== 'owner' && !Number.isInteger(chat)) throw configError(`${where}: 'chat' must be "owner" or a numeric chat id, got ${JSON.stringify(chat)}`);
  const enabled = 'enabled' in raw ? raw.enabled : true;
  if (typeof enabled !== 'boolean') throw configError(`${where}: 'enabled' must be true or false, got ${JSON.stringify(enabled)}`);
  const chatId = chat === 'owner' ? ownerId : (chat as number);
  const digest = createHash('sha256').update(`${cron}\n${text}\n${chatId}`).digest('hex').slice(0, 8);
  return { name, cron, text, chatId, enabled, key: `${KEY_PREFIX}${name}:${digest}` };
}

function requireText(raw: Record<string, unknown>, key: string, where: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || !value.trim()) throw configError(`${where}: '${key}' is required and must be non-empty`);
  return value;
}

/** A string, or a list of strings joined with newlines (JSON has no multi-line strings). */
function reminderText(value: unknown, where: string): string {
  if (Array.isArray(value) && !value.every((line) => typeof line === 'string')) throw configError(`${where}: 'text' list items must be strings`);
  const text = Array.isArray(value) ? value.join('\n') : value;
  if (typeof text !== 'string') throw configError(`${where}: 'text' is required and must be a string or a list of strings`);
  if (!text.trim()) throw configError(`${where}: 'text' must be non-empty`);
  return text;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
