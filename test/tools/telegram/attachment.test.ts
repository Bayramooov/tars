import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ToolCallRow } from '../../../src/db/toolcalls.ts';
import { McpHttpServer } from '../../../src/mcp/server.ts';
import { AttachmentStore } from '../../../src/stores/attachments.ts';
import { readAttachmentTool } from '../../../src/tools/telegram/attachment.ts';
import { expectGoldenTool } from '../../golden/tools.ts';
import { memoryLogger } from '../../helpers/log.ts';
import { pdf } from '../../helpers/pdf.ts';
import { tempDir } from '../../helpers/tmp.ts';
import { call } from './harness.ts';

/** The attachments root as the dispatcher fills it: `<chat_id>/<message_id>_<name>`. */
function setup() {
  const dir = join(tempDir(), 'attachments');
  mkdirSync(join(dir, '111'), { recursive: true });
  writeFileSync(join(dir, '111', '5_photo_5.jpg'), 'jpeg');
  writeFileSync(join(dir, '111', '6_notes.md'), '# notes');
  writeFileSync(join(dir, '111', '7_doc.pdf'), pdf(['Hello']));
  const store = new AttachmentStore(dir);
  const tool = readAttachmentTool(store);
  const log = memoryLogger();
  const audit: ToolCallRow[] = [];
  const server = new McpHttpServer({ tools: [tool], log, beat: () => {}, audit: (row) => void audit.push(row) });
  return { dir, store, tool, server, log, audit };
}

describe('telegram_read_attachment', () => {
  it('matches the tools/list snapshot', () => {
    expectGoldenTool(setup().tool);
  });

  it('shows an image to the model as an image block; the audit gets its description and absolute path', async () => {
    const t = setup();
    const abs = join(t.store.root, '111', '5_photo_5.jpg');
    expect(await call(t.tool, { path: join(t.dir, '111', '5_photo_5.jpg') })).toEqual({
      content: 'image attachment 111/5_photo_5.jpg (image/jpeg, 4 bytes)',
      data: { path: abs, mime: 'image/jpeg', size_bytes: 4 },
      imagePath: abs,
    });
    expect(await t.server.call('telegram_read_attachment', { path: '111/5_photo_5.jpg' })).toEqual({
      content: [{ type: 'image', data: Buffer.from('jpeg').toString('base64'), mimeType: 'image/jpeg' }],
      isError: false,
    });
  });

  it('returns text files and PDFs as text', async () => {
    const t = setup();
    expect(await call(t.tool, { path: '111/6_notes.md' })).toEqual({ content: '# notes', data: { path: '111/6_notes.md', size_bytes: 7, truncated: false } });
    expect(await call(t.tool, { path: '111/7_doc.pdf' })).toEqual({
      content: '--- page 1 ---\nHello',
      data: { path: '111/7_doc.pdf', size_bytes: pdf(['Hello']).length, truncated: false, kind: 'pdf' },
    });
  });

  it('answers every failure with a handled error result', async () => {
    const t = setup();
    const err = (content: string) => ({ content, isError: true });
    expect(await call(t.tool, { path: '/etc/passwd' })).toEqual(err('path is not under attachments root: /etc/passwd'));
    expect(await call(t.tool, { path: '../x.txt' })).toEqual(err('attachment path may not contain \'..\': "../x.txt"'));
    expect(await call(t.tool, { path: '111/setup.exe' })).toEqual(err('attachment 111/setup.exe has unsupported kind for reading'));
    expect(await call(t.tool, { path: '111/gone.txt' })).toEqual(err('attachment not found: 111/gone.txt'));
  });

  it('does not report a handled failure as a tool exception', async () => {
    const t = setup();
    expect(await t.server.call('telegram_read_attachment', { path: '111/gone.txt' })).toEqual({
      content: [{ type: 'text', text: 'attachment not found: 111/gone.txt' }],
      isError: true,
    });
    expect(t.audit[0]?.error).toBeUndefined();
    expect(t.log.text()).not.toContain('failed');
  });
});
