import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { InputFile } from 'grammy';
import { describe, expect, it } from 'vitest';

import { resolveUnderRoot } from '../../../src/stores/paths.ts';
import { type MemoryFiles, sendMemoryDocumentTool } from '../../../src/tools/telegram/document.ts';
import { expectGoldenTool } from '../../golden/tools.ts';
import { tempDir } from '../../helpers/tmp.ts';
import { call, messageRow, toolContext, uploaded } from './harness.ts';

const REPORT = '---\nname: report\ndescription: a report\n---\n\n# Report\nbody';

/** A memory root holding notes/report.md, behind the interface the tool needs (the memory store's rules). */
function memory(): MemoryFiles {
  const root = realpathSync(tempDir());
  mkdirSync(join(root, 'notes'));
  writeFileSync(join(root, 'notes', 'report.md'), REPORT);
  return {
    resolveReadable(path) {
      if (!path.startsWith('memories/')) throw new Error(`memory path must start with 'memories/': got ${JSON.stringify(path)}`);
      const file = resolveUnderRoot(root, path.slice('memories/'.length), 'memory');
      if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`memory file not found: ${path}`);
      return file;
    },
  };
}

describe('telegram_send_memory_document', () => {
  it('matches the tools/list snapshot', () => {
    expectGoldenTool(sendMemoryDocumentTool(toolContext().ctx, memory()));
  });

  it('uploads the memory file under its own name (no topic) and records it', async () => {
    const t = toolContext();
    const out = await call(sendMemoryDocumentTool(t.ctx, memory()), { chat_id: 123, path: 'memories/notes/report.md' });
    const payload = t.fake.sent('sendDocument')[0]?.payload ?? {};
    expect(Object.keys(payload).filter((k) => payload[k] !== undefined)).toEqual(['chat_id', 'document']);
    expect((payload.document as InputFile).filename).toBe('report.md');
    expect(await uploaded(payload.document)).toBe(REPORT);
    expect(out).toEqual({ content: 'sent document message_id=5001 (report.md)', data: { message_id: 5001, chat_id: 123, filename: 'report.md', path: 'memories/notes/report.md' } });
    expect(messageRow(t.db, 123, 5001)).toMatchObject({ direction: 'out', text: '[document] memories/notes/report.md' });
    expect(t.log.text()).toContain('hot-path stage=delivered chat=123 msg=5001 document=memories/notes/report.md');
  });

  it('passes the caption and reply target through', async () => {
    const t = toolContext();
    await call(sendMemoryDocumentTool(t.ctx, memory()), { chat_id: 111, path: 'memories/notes/report.md', caption: 'here you go', reply_to_message_id: 55 });
    expect(t.fake.sent('sendDocument')[0]?.payload).toMatchObject({ caption: 'here you go', reply_parameters: { message_id: 55 } });
    expect(messageRow(t.db, 111, 5001)).toMatchObject({ text: '[document] memories/notes/report.md — here you go', reply_to_id: 55 });
    expect(t.log.text()).toContain('[TX] DM Ali[111] m5001 →m55 | [document] memories/notes/report.md — here you go');
  });

  it('refuses unsafe and missing paths without uploading', async () => {
    const t = toolContext();
    const tool = sendMemoryDocumentTool(t.ctx, memory());
    expect(await call(tool, { chat_id: 1, path: 'memories/../etc/passwd' })).toEqual({ content: 'memory path may not contain \'..\': "../etc/passwd"', isError: true });
    expect(await call(tool, { chat_id: 1, path: '/etc/passwd' })).toEqual({ content: 'memory path must start with \'memories/\': got "/etc/passwd"', isError: true });
    expect(await call(tool, { chat_id: 1, path: 'memories/does/not/exist.md' })).toEqual({ content: 'memory file not found: memories/does/not/exist.md', isError: true });
    expect(t.fake.sent('sendDocument')).toEqual([]);
  });

  it('stops the chat\'s typing indicator once Telegram confirmed the upload', async () => {
    const t = toolContext();
    await call(sendMemoryDocumentTool(t.ctx, memory()), { chat_id: 999, path: 'memories/notes/report.md' });
    expect(t.replied).toEqual([999]);
  });
});
