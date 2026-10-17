import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openDatabase } from '../../src/db/database.ts';
import { insertMessage } from '../../src/db/messages.ts';
import { OWNER, testApp } from '../helpers/app.ts';
import { memoryLogger } from '../helpers/log.ts';
import { until } from '../helpers/wait.ts';

type TestApp = ReturnType<typeof testApp>;
const running: TestApp[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((t) => t.app.stop()));
  vi.unstubAllEnvs();
});

function make(env: Record<string, string> = {}): TestApp {
  const t = testApp(env);
  running.push(t);
  return t;
}

describe('app lifecycle', () => {
  it('replays a message buffered before the last shutdown', async () => {
    const t = make();
    mkdirSync(t.config.dataDir, { recursive: true });
    const db = openDatabase(t.config.dbPath, memoryLogger());
    insertMessage(db, { chatId: OWNER.id, messageId: 77, userId: OWNER.id, firstName: 'Owner', direction: 'in', timestamp: new Date(), text: 'from before' });
    db.close();
    await t.app.start();
    await t.telegram.waitFor('sendMessage', (p) => p.text === 'echo: from before', 15_000);
    expect(t.log.text()).toContain('replaying 1 message(s) buffered before the last shutdown');
  });

  it('deletes raw captures, renders and tool-call rows older than 30 days at boot', async () => {
    const t = make();
    const old = new Date(Date.now() - 31 * 86_400_000);
    for (const dir of [t.config.ccLogsDir, t.config.rendersDir]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'old.png'), 'x');
      utimesSync(join(dir, 'old.png'), old, old);
      writeFileSync(join(dir, 'new.png'), 'x');
    }
    const db = openDatabase(t.config.dbPath, memoryLogger());
    db.prepare("INSERT INTO tool_calls(tool_name, args_json, created_at) VALUES ('old', '{}', datetime('now', '-31 days')), ('new', '{}', datetime('now'))").run();
    db.close();
    await t.app.start();
    for (const dir of [t.config.ccLogsDir, t.config.rendersDir]) expect(readdirSync(dir).filter((name) => name.endsWith('.png'))).toEqual(['new.png']);
    const reopened = openDatabase(t.config.dbPath, memoryLogger());
    expect(reopened.prepare('SELECT tool_name FROM tool_calls').pluck().all()).toEqual(['new']);
    reopened.close();
  });

  it('recovers from a stale session: fresh session, recap stashed, owner told', async () => {
    vi.stubEnv('FAKE_CLAUDE_STALE', '1');
    const t = make({ TARS_CRASH_BACKOFF_BASE: '0.05' });
    mkdirSync(t.config.dataDir, { recursive: true });
    writeFileSync(t.config.sessionIdPath, 'dead-session');
    await t.app.start();
    const notice = await t.telegram.waitFor('sendMessage', (p) => String(p.text).startsWith('ℹ️ Previous Claude Code session expired'), 15_000);
    expect(notice.payload.chat_id).toBe(OWNER.id);
    expect(existsSync(t.config.sessionIdPath)).toBe(false);
    t.telegram.message({ id: OWNER.id }, OWNER, 'still there?');
    await t.telegram.waitFor('sendMessage', (p) => p.text === 'echo: still there?', 15_000);
  });

  it('asks to exit once Claude Code keeps crashing, telling the owner about each crash', async () => {
    const t = make({ CLAUDE_CODE_BIN: '/usr/bin/false', TARS_CRASH_LIMIT: '2', TARS_CRASH_BACKOFF_BASE: '0.01' });
    await t.app.start();
    await until(() => t.fatal.length > 0, 15_000);
    expect(t.fatal).toEqual(['claude crash limit reached']);
    expect(t.log.text()).toContain('⚠️ Shutting down — Claude Code failed 2 times. The operator needs to intervene.');
    const crash = t.log.records.find((r) => r.msg === 'cc subprocess exited rc=1; recent stderr=[]');
    expect(crash?.name).toBe('tars.worker');
    expect(t.log.text()).toContain('ERROR respawning cc in 0.0s (attempt 1)');
    await t.telegram.waitFor('sendMessage', (p) => String(p.text).startsWith('⚠️ ERROR — tars.worker\ncc subprocess exited rc=1'), 15_000);
  });

  it('DMs the owner about errors in HTML, linking the message being answered', async () => {
    const t = make();
    await t.app.start();
    t.telegram.message({ id: OWNER.id }, OWNER, '#fake text There is an issue with the selected model\n#fake control {"action":"stop","reason":"x"}');
    const dm = await t.telegram.waitFor('sendMessage', (p) => p.parse_mode === 'HTML' && String(p.text).includes('⚠️ ERROR — tars.engine'), 15_000);
    expect(dm.payload.chat_id).toBe(OWNER.id);
    expect(dm.payload.text).toContain('The configured Claude model is unavailable');
    expect(dm.payload.text).toContain(`• message 5001 from @owner (id ${OWNER.id})`);
  });

  it('refuses to run twice on one data directory', async () => {
    const first = make();
    await first.app.start();
    const second = testApp({ TARS_DATA_DIR: first.config.dataDir });
    await expect(second.app.start()).rejects.toThrow(/another tars instance is already running on .* \(data\/\.instance\.lock is held\)/);
  });

  it('saves the session id and shuts down cleanly', async () => {
    const t = make();
    await t.app.start();
    t.telegram.message({ id: OWNER.id }, OWNER, 'hi');
    await t.telegram.waitFor('sendMessage', (p) => p.text === 'echo: hi', 15_000);
    running.splice(running.indexOf(t), 1);
    await t.app.stop();
    expect(readFileSync(t.config.sessionIdPath, 'utf8')).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.log.text()).toContain('clean shutdown complete');
    expect(existsSync(join(t.config.dataDir, '.instance.lock'))).toBe(true);
  });

  it('boots in order — disk, access, database, plugins, tools, MCP server, Claude Code, Telegram — then says it is live', async () => {
    const t = make();
    await t.app.start();
    const text = t.log.text();
    const steps = ['access: policy=owner_only', 'database ready at', 'plugins loaded:', 'registered MCP tool', 'mcp server live at http://127.0.0.1:', 'spawning claude', 'telegram dispatcher polling', 'tars is live'];
    const at = steps.map((step) => text.indexOf(step));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const c = t.config;
    for (const dir of [c.dataDir, c.memoriesDir, c.ccLogsDir, c.attachmentsDir, c.rendersDir, c.logDir]) expect(existsSync(dir)).toBe(true);
  });

  it('prepares reminders at boot: self-reflection seeded, committed reminders reconciled', async () => {
    const t = make({ TARS_SELF_REFLECTION_ENABLED: 'true', TARS_SELF_REFLECTION_CRON: '0 3 * * *' });
    writeFileSync(t.config.committedRemindersPath, JSON.stringify({ reminders: [{ name: 'digest', cron: '0 6 * * *', chat: 'owner', enabled: true, text: 'Post the digest.' }] }));
    await t.app.start();
    expect(t.log.text()).toMatch(/INFO seeded default self-reflection reminder \(cron=0 3 \* \* \*, next=\d{4}-\d\d-\d\d 03:00:00 UTC\)/);
    expect(t.log.text()).toContain('INFO committed reminders: 1 declared, 1 seeded, 0 cancelled, 0 unchanged');
    const db = openDatabase(t.config.dbPath, memoryLogger());
    const rows = db.prepare('SELECT chat_id, user_id, text, cron_expr, status, auto_seed_key FROM reminders ORDER BY id').all();
    db.close();
    expect(rows).toEqual([
      { chat_id: OWNER.id, user_id: -1, text: '<skill name="self-reflection">run</skill>', cron_expr: '0 3 * * *', status: 'pending', auto_seed_key: 'self-reflection-default' },
      expect.objectContaining({ chat_id: OWNER.id, user_id: -1, text: 'Post the digest.', cron_expr: '0 6 * * *', status: 'pending' }),
    ]);
  });
});

