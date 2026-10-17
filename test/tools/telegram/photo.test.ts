import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { InputFile } from 'grammy';
import { describe, expect, it } from 'vitest';

import { resolveUnderRoot } from '../../../src/stores/paths.ts';
import { type RenderFiles, sendPhotoTool } from '../../../src/tools/telegram/photo.ts';
import { expectGoldenTool } from '../../golden/tools.ts';
import { tempDir } from '../../helpers/tmp.ts';
import { call, messageRow, toolContext, uploaded } from './harness.ts';

const PNG = '20261017T120000-chart-a1b2c3.png';

/** A renders root holding one PNG, behind the interface the tool needs (the render store's rules). */
function renders(): { root: string; files: RenderFiles } {
  const root = realpathSync(tempDir());
  writeFileSync(join(root, PNG), 'png bytes');
  mkdirSync(join(root, 'sub'));
  const files: RenderFiles = {
    resolvePath: (path) => resolveUnderRoot(root, path, 'render'),
    isFile: (path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false,
  };
  return { root, files };
}

describe('telegram_send_photo', () => {
  it('matches the tools/list snapshot', () => {
    expectGoldenTool(sendPhotoTool(toolContext().ctx, renders().files));
  });

  it('uploads the render as a photo (no topic), records it, and names the file', async () => {
    const t = toolContext();
    const out = await call(sendPhotoTool(t.ctx, renders().files), { chat_id: 111, path: PNG });
    const payload = t.fake.sent('sendPhoto')[0]?.payload ?? {};
    expect(Object.keys(payload).filter((k) => payload[k] !== undefined)).toEqual(['chat_id', 'photo']);
    expect((payload.photo as InputFile).filename).toBe(PNG);
    expect(await uploaded(payload.photo)).toBe('png bytes');
    expect(out).toEqual({ content: `sent photo message_id=5001 (${PNG})`, data: { message_id: 5001, chat_id: 111, filename: PNG, path: PNG } });
    expect(messageRow(t.db, 111, 5001)).toMatchObject({ direction: 'out', text: `[photo] ${PNG}`, reply_to_id: null });
    expect(t.log.text()).toContain(`hot-path stage=delivered chat=111 msg=5001 photo=${PNG}`);
    expect(t.log.text()).toContain(`[TX] DM Ali[111] m5001 | [photo] ${PNG}`);
    expect(t.replied).toEqual([111]);
  });

  it('passes a plain caption and a reply target, and stops typing before writing the transcript and row', async () => {
    const t = toolContext();
    const seen: string[] = [];
    const ctx = { ...t.ctx, onChatReplied: () => void seen.push(`rows=${String(t.db.prepare('SELECT COUNT(*) FROM messages').pluck().get())} tx=${t.log.text().includes('[TX]')}`) };
    await call(sendPhotoTool(ctx, renders().files), { chat_id: 111, path: PNG, caption: 'Q3 *numbers*', reply_to_message_id: 42 });
    expect(t.fake.sent('sendPhoto')[0]?.payload).toMatchObject({ caption: 'Q3 *numbers*', reply_parameters: { message_id: 42 } });
    expect(t.fake.sent('sendPhoto')[0]?.payload.parse_mode).toBeUndefined();
    expect(seen).toEqual(['rows=0 tx=false']);
    expect(messageRow(t.db, 111, 5001)).toMatchObject({ text: `[photo] ${PNG} — Q3 *numbers*`, reply_to_id: 42 });
    expect(t.log.text()).toContain(`[TX] DM Ali[111] m5001 →m42 | [photo] ${PNG} — Q3 *numbers*`);
  });

  it('refuses unsafe and missing paths without calling Telegram', async () => {
    const t = toolContext();
    const { root, files } = renders();
    const tool = sendPhotoTool(t.ctx, files);
    expect(await call(tool, { chat_id: 1, path: '../etc/passwd' })).toEqual({ content: 'render path may not contain \'..\': "../etc/passwd"', isError: true });
    expect(await call(tool, { chat_id: 1, path: '/etc/passwd' })).toEqual({ content: `render path must be relative to ${root}, got "/etc/passwd"`, isError: true });
    expect(await call(tool, { chat_id: 1, path: 'nope.png' })).toEqual({ content: 'render not found: nope.png', isError: true });
    expect(await call(tool, { chat_id: 1, path: 'sub' })).toEqual({ content: 'render not found: sub', isError: true });
    expect(t.fake.sent('sendPhoto')).toEqual([]);
  });

  it('surfaces a Telegram failure after the checks pass', async () => {
    const t = toolContext();
    t.fake.fail('sendPhoto', 403, 'Forbidden: bot was blocked by the user');
    await expect(call(sendPhotoTool(t.ctx, renders().files), { chat_id: 111, path: PNG })).rejects.toMatchObject({
      name: 'GrammyError',
      message: "Call to 'sendPhoto' failed! (403: Forbidden: bot was blocked by the user)",
    });
    expect(t.replied).toEqual([]);
  });
});
