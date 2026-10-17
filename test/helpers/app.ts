import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { FakeTelegram } from '../fakes/telegram.ts';
import { memoryLogger } from './log.ts';
import { tempDir } from './tmp.ts';

export const FAKE_CLAUDE = fileURLToPath(new URL('../fakes/fake-claude.ts', import.meta.url));
export const OWNER = { id: 111, first_name: 'Owner', username: 'owner' };

/** A whole tars app on fakes: fake Telegram, fake claude, temp data dir, and a file "server" for attachments. */
export function testApp(env: Record<string, string> = {}, access: object = { policy: 'owner_only', allowed_users: [], allowed_chats: [] }) {
  const dir = tempDir();
  writeFileSync(join(dir, 'access.json'), JSON.stringify(access));
  const fakeLog = join(dir, 'fake-claude.jsonl');
  process.env.FAKE_CLAUDE_LOG = fakeLog;
  const config = loadConfig(
    {
      TELEGRAM_BOT_TOKEN: '123456:test-token',
      TARS_OWNER_ID: String(OWNER.id),
      TARS_MODEL: 'claude-test',
      TARS_EFFORT: 'high',
      CLAUDE_CODE_BIN: FAKE_CLAUDE,
      TARS_DATA_DIR: join(dir, 'data'),
      TARS_ACCESS_PATH: join(dir, 'access.json'),
      TARS_PLUGINS_PATH: join(dir, 'plugins.json'),
      TARS_MEMORIES_DIR: join(dir, 'memories'),
      TARS_REMINDERS_PATH: join(dir, 'default-reminders.json'),
      TARS_SELF_REFLECTION_ENABLED: 'false',
      ...env,
    },
    dir,
  );
  const telegram = new FakeTelegram();
  const log = memoryLogger();
  const fatal: string[] = [];
  const kills: number[] = [];
  /** Telegram-hosted files by `file_id`, served to the attachment downloader (a promise holds the download back). */
  const files = new Map<string, string | Promise<string>>();
  const download = async (url: string, dest: string) => writeFileSync(dest, (await files.get(url.slice(url.lastIndexOf('/') + 1))) ?? '');
  const app = createApp(config, {
    log, env: {}, telegram: telegram.transformer, botInfo: telegram.botInfo, download,
    onFatal: (r) => void fatal.push(r), onKill: () => void kills.push(Date.now()), addLogSink: (sink) => log.addSink(sink),
  });
  /** What the fake `claude` recorded so far (nothing before it has started). */
  const claudeLog = () =>
    existsSync(fakeLog)
      ? readFileSync(fakeLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { kind: string; argv?: string[]; line?: string; name?: string })
      : [];
  return { app, config, telegram, files, log, fatal, kills, dir, claudeLog };
}
