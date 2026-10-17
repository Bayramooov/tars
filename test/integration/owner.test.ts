import { afterEach, describe, expect, it } from 'vitest';

import { OWNER, testApp } from '../helpers/app.ts';
import { until } from '../helpers/wait.ts';

type TestApp = ReturnType<typeof testApp>;
const running: TestApp[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((t) => t.app.stop()));
});

async function started(): Promise<TestApp> {
  const t = testApp();
  running.push(t);
  await t.app.start();
  return t;
}

describe('owner surface, end to end', () => {
  it('shows the command menu in the owner\'s chat before polling starts', async () => {
    const t = await started();
    await until(() => t.telegram.calls.some((c) => c.method === 'getUpdates'));
    const menu = t.telegram.calls.findIndex((c) => c.method === 'setMyCommands');
    expect(t.telegram.calls[menu]?.payload).toMatchObject({ scope: { type: 'chat', chat_id: OWNER.id } });
    expect(menu).toBeLessThan(t.telegram.calls.findIndex((c) => c.method === 'getUpdates'));
  });

  it('/kill answers, then asks the process to shut down', async () => {
    const t = await started();
    t.telegram.message({ id: OWNER.id }, OWNER, '/kill');
    await t.telegram.waitFor('sendMessage', (p) => p.text === 'Shutting down…', 15_000);
    await until(() => t.kills.length === 1);
    expect(t.claudeLog().filter((e) => e.kind === 'stdin')).toEqual([]);
  });

  it('/pause drops messages until /resume, and commands never reach Claude Code', async () => {
    const t = await started();
    t.telegram.message({ id: OWNER.id }, OWNER, '/pause');
    await until(() => t.log.text().includes('/pause'));
    t.telegram.message({ id: OWNER.id }, OWNER, 'dropped while paused');
    t.telegram.message({ id: OWNER.id }, OWNER, '/resume');
    t.telegram.message({ id: OWNER.id }, OWNER, 'after resume');
    await t.telegram.waitFor('sendMessage', (p) => p.text === 'echo: after resume', 15_000);
    const stdin = t.claudeLog().filter((e) => e.kind === 'stdin').map((e) => e.line ?? '');
    expect(stdin).toHaveLength(1);
    expect(stdin[0]).not.toContain('dropped while paused');
  });

  it('hands a sent file to Claude Code as an attachment marker after the caption', async () => {
    const t = await started();
    t.files.set('doc1', 'meeting notes');
    const document = { file_id: 'doc1', file_unique_id: 'u1', file_name: 'notes.txt', mime_type: 'text/plain', file_size: 13 };
    t.telegram.message({ id: OWNER.id }, OWNER, '', { text: undefined, caption: 'read this', document });
    await until(() => t.claudeLog().some((e) => e.kind === 'stdin'));
    const stdin = t.claudeLog().find((e) => e.kind === 'stdin')?.line ?? '';
    expect(stdin).toContain('read this\\n[attachment: ');
    expect(stdin).toContain('type=text/plain size=13B filename=notes.txt]');
  });
});
