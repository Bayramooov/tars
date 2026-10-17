import { readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openDailyFile } from '../../src/log/daily.ts';
import { createLogger, type LogRecord } from '../../src/log/logger.ts';
import { formatRecord, OwnerNotifier } from '../../src/log/owner.ts';
import { formatConsole, formatJson } from '../../src/log/sinks.ts';
import { htmlToPlainText } from '../../src/text/html.ts';
import { loadGolden } from '../golden/load.ts';
import { tempDir } from '../helpers/tmp.ts';

afterEach(() => vi.useRealTimers());

const record = (over: Partial<LogRecord> = {}): LogRecord => ({ time: new Date(Date.UTC(2026, 9, 17, 1, 2, 3, 456)), level: 'INFO', name: 'tars.engine', msg: 'turn done', ...over });

describe('log formats', () => {
  it('console: HH:MM:SS LEVEL logger message', () => {
    expect(formatConsole(record())).toMatch(/^\d\d:\d\d:\d\d INFO {2}tars\.engine {12}turn done$/);
  });

  it('JSON: one object per line with an ISO timestamp', () => {
    expect(formatJson(record({ event: 'turn', data: { n: 1 } }))).toBe(
      '{"ts":"2026-10-17T01:02:03.456Z","level":"INFO","logger":"tars.engine","msg":"turn done","event":"turn","data":{"n":1}}',
    );
    expect(formatJson(record({ msg: 'Ўзбек' }))).toContain('"msg":"Ўзбек"');
  });

  it('JSON carries the stack of an error', () => {
    expect(formatJson(record({ level: 'ERROR', err: new Error('boom') }))).toMatch(/"exc":"Error: boom\\n {4}at /);
  });

  it('drops records below the configured level', () => {
    const seen: string[] = [];
    const log = createLogger([(r) => seen.push(r.msg)], 'WARNING');
    log.info('quiet');
    log.child('engine').warn('loud');
    expect(seen).toEqual(['loud']);
  });
});

describe('daily log file', () => {
  it('rotates at local midnight into tars.log.YYYY-MM-DD and keeps 7', () => {
    const dir = tempDir();
    const path = join(dir, 'tars.log');
    for (let day = 1; day <= 8; day++) writeFileSync(`${path}.2026-01-0${day}`, 'old\n');
    writeFileSync(path, 'yesterday\n');
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    utimesSync(path, yesterday, yesterday);
    const file = openDailyFile(path, 7);
    file.write('today\n');
    file.close();
    const stamp = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    expect(readFileSync(path, 'utf8')).toBe('today\n');
    expect(readFileSync(`${path}.${stamp}`, 'utf8')).toBe('yesterday\n');
    expect(readdirSync(dir).filter((n) => n.startsWith('tars.log.'))).toHaveLength(7);
  });
});

interface NotifierGolden {
  format_record: { level: string; name: string; message: string; out: string }[];
  to_plain_text: { in: string; out: string }[];
}

describe('owner notifier', () => {
  const golden = loadGolden<NotifierGolden>('owner-notifier.json');

  it('formats records and their plain-text fallbacks', () => {
    for (const c of golden.format_record) {
      expect(formatRecord(record({ level: c.level as LogRecord['level'], name: c.name, msg: c.message }))).toBe(c.out);
    }
    for (const c of golden.to_plain_text) expect(htmlToPlainText(c.in)).toBe(c.out);
  });

  it('DMs errors once per minute with the cause link, never re-entrantly', async () => {
    const sent: string[] = [];
    let release: () => void = () => {};
    const notifier = new OwnerNotifier((html) => new Promise<void>((r) => ((release = r), sent.push(html))), () => '• message 5 from @a (id 1)');
    notifier.sink(record({ level: 'INFO' }));
    notifier.sink(record({ level: 'ERROR', msg: 'boom' }));
    notifier.sink(record({ level: 'ERROR', msg: 'during send' }));
    release();
    await notifier.flush();
    notifier.sink(record({ level: 'ERROR', msg: 'boom' }));
    expect(sent).toEqual(['⚠️ ERROR — tars.engine\nboom\n\n• message 5 from @a (id 1)']);
  });

  it('cuts a DM with its cause links at 4000 characters', async () => {
    const sent: string[] = [];
    const notifier = new OwnerNotifier((html) => Promise.resolve(void sent.push(html)), () => `• ${'r'.repeat(5000)}`);
    notifier.sink(record({ level: 'ERROR', msg: 'boom' }));
    await notifier.flush();
    expect([...(sent[0] ?? '')]).toHaveLength(4000);
    expect(sent[0]?.endsWith('r…')).toBe(true);
  });

  it('sends nothing when the log level is above ERROR', async () => {
    const sent: string[] = [];
    const notifier = new OwnerNotifier((html) => Promise.resolve(void sent.push(html)), () => '');
    createLogger([notifier.sink], 'CRITICAL', 'tars').error('boom');
    await notifier.flush();
    expect(sent).toEqual([]);
  });
});

