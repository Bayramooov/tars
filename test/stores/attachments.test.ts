import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AttachmentStore } from '../../src/stores/attachments.ts';
import { pdf } from '../helpers/pdf.ts';
import { tempDir } from '../helpers/tmp.ts';

/** A store whose root is reached through a symlinked parent, like a bind-mounted data dir. */
function setup() {
  const real = tempDir();
  mkdirSync(join(real, 'attachments', '111'), { recursive: true });
  const link = join(tempDir(), 'data');
  symlinkSync(real, link);
  const dir = join(link, 'attachments');
  const store = new AttachmentStore(dir);
  const put = (rel: string, body: string | Buffer) => writeFileSync(join(store.root, rel), body);
  return { dir, store, put };
}

describe('AttachmentStore paths', () => {
  it('passes relative paths through and maps absolute ones under the root, as the marker or canonical path', () => {
    const { dir, store } = setup();
    expect(store.relativePath('111/a.txt')).toBe('111/a.txt');
    expect(store.relativePath(join(dir, '111', 'a.txt'))).toBe('111/a.txt');
    expect(store.relativePath(`${store.root}/111/../111/a.txt`)).toBe('111/a.txt');
    expect(store.relativePath(store.root)).toBe('.');
    expect(store.relativePath('/etc/passwd')).toBeUndefined();
    expect(store.relativePath(`${store.root}-old/111/a.txt`)).toBeUndefined();
  });

  it('rejects empty paths, traversal and symlinks', async () => {
    const { store, put } = setup();
    put('111/a.txt', 'hi');
    symlinkSync(join(store.root, '111', 'a.txt'), join(store.root, '111', 'b.txt'));
    await expect(store.read('')).rejects.toMatchObject({ message: 'attachment path must be a non-empty string' });
    await expect(store.read('111/../../x.txt')).rejects.toMatchObject({ message: `attachment path may not contain '..': "111/../../x.txt"` });
    await expect(store.read('111/b.txt')).rejects.toMatchObject({ message: `symlink in attachment path: ${join(store.root, '111', 'b.txt')}` });
  });
});

describe('AttachmentStore reads', () => {
  it('decides the kind by extension alone, before looking for the file', async () => {
    const { store, put } = setup();
    for (const rel of ['111/run.exe', '111/a.tar.gz', '111/.md', '111/noext']) expect(await store.read(rel)).toEqual({ kind: 'unsupported' });
    put('111/5_photo_5.JPG', 'jpg');
    expect(await store.read('111/5_photo_5.JPG')).toEqual({ kind: 'image', path: join(store.root, '111', '5_photo_5.JPG'), mime: 'image/jpeg', sizeBytes: 3 });
    put('111/x.webp', 'w');
    expect(await store.read('111/x.webp')).toMatchObject({ mime: 'image/webp' });
    await expect(store.read('111/gone.png')).rejects.toMatchObject({ message: 'attachment not found: 111/gone.png' });
    mkdirSync(join(store.root, '111', 'dir.txt'));
    await expect(store.read('111/dir.txt')).rejects.toMatchObject({ message: 'attachment not found: 111/dir.txt' });
  });

  it('reads text as UTF-8 with bad bytes replaced, cut at 65536 bytes with a marker', async () => {
    const { store, put } = setup();
    put('111/a.txt', Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69, 0xff]));
    expect(await store.read('111/a.txt')).toEqual({ kind: 'text', text: '\u{FEFF}hi\u{FFFD}', truncated: false, sizeBytes: 6 });
    put('111/big.log', `${'a'.repeat(65535)}€tail`);
    expect(await store.read('111/big.log')).toEqual({
      kind: 'text',
      text: `${'a'.repeat(65535)}\u{FFFD}\n\n[truncated to 65536 bytes of 65542 total]`,
      truncated: true,
      sizeBytes: 65542,
    });
  });

  it('extracts each PDF page, stripped, under a page marker', async () => {
    const { store, put } = setup();
    const file = pdf(['Hello page one', '  second  ']);
    put('111/doc.pdf', file);
    expect(await store.read('111/doc.pdf')).toEqual({ kind: 'pdf', text: '--- page 1 ---\nHello page one\n\n--- page 2 ---\nsecond', truncated: false, sizeBytes: file.length });
  });

  it('cuts long PDF text on a character boundary and gives the page count', async () => {
    const { store, put } = setup();
    put('111/long.pdf', pdf(['\\351'.repeat(33000)]));
    const read = await store.read('111/long.pdf');
    expect(read).toMatchObject({ kind: 'pdf', truncated: true });
    expect(read.kind === 'pdf' && read.text).toBe(`--- page 1 ---\n${'é'.repeat(32760)}\n\n[truncated to 65536 bytes; PDF has 1 pages total]`);
  });

  it('refuses password-protected and unparsable PDFs', async () => {
    const { store, put } = setup();
    put('111/secret.pdf', pdf(['secret'], { encrypted: true }));
    await expect(store.read('111/secret.pdf')).rejects.toMatchObject({ message: 'PDF 111/secret.pdf is password-protected; cannot read' });
    put('111/bad.pdf', 'not a pdf');
    await expect(store.read('111/bad.pdf')).rejects.toMatchObject({ message: 'could not parse PDF 111/bad.pdf: Invalid PDF structure.' });
  });
});
