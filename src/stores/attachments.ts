import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

import { extractText, getDocumentProxy } from 'unpdf';

import { resolveUnderRoot } from './paths.ts';

/** Cap on the text handed back for one text or PDF attachment, in UTF-8 bytes. */
const MAX_TEXT_BYTES = 65536;

export const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
export const TEXT_EXTS = new Set(['md', 'txt', 'log', 'csv', 'json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'py', 'js', 'ts', 'tsx', 'jsx', 'html', 'css', 'sh', 'sql', 'xml', 'rst']);
const IMAGE_MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

/** An attachment as the model gets it: an image file to show, or text. */
export type Attachment =
  | { kind: 'image'; path: string; mime: string; sizeBytes: number }
  | { kind: 'text' | 'pdf'; text: string; truncated: boolean; sizeBytes: number }
  | { kind: 'unsupported' };

/**
 * Read-only access to `data/attachments/`, where the dispatcher saves inbound
 * photos and documents. Paths are hardened like every store's; what is
 * readable (image, text, PDF) is decided by the file extension alone.
 */
export class AttachmentStore {
  /** Canonical root, so containment checks see through symlinked parents. */
  readonly root: string;

  constructor(dir: string) {
    this.root = realpathSync(dir);
  }

  /**
   * The path relative to the root: relative input passes through, an
   * absolute one (as printed in an `[attachment: …]` marker) has its symlinks
   * resolved and must land under the root (else undefined).
   */
  relativePath(path: string): string | undefined {
    if (!isAbsolute(path)) return path;
    const rel = relative(this.root, realpathLoose(resolve(path)));
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return undefined;
    return rel || '.';
  }

  /** Throws for an unsafe path, a missing file or an unreadable PDF. */
  async read(rel: string): Promise<Attachment> {
    const path = resolveUnderRoot(this.root, rel, 'attachment');
    const ext = extname(path).slice(1).toLowerCase();
    const kind = kindOf(ext);
    if (kind === 'unsupported') return { kind };
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`attachment not found: ${rel}`);
    if (kind === 'image') return { kind, path, mime: IMAGE_MIME[ext] ?? '', sizeBytes: stat.size };
    if (kind === 'text') return { kind, ...readText(path), sizeBytes: stat.size };
    return { kind, ...(await readPdf(path, rel)), sizeBytes: stat.size };
  }
}

function kindOf(ext: string): Attachment['kind'] {
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (TEXT_EXTS.has(ext)) return 'text';
  return ext === 'pdf' ? 'pdf' : 'unsupported';
}

/** Symlinks followed as far as the path exists, the rest kept. */
function realpathLoose(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realpathLoose(parent), basename(path));
  }
}

/** UTF-8 with invalid bytes replaced, cut at the byte cap. */
function readText(path: string): { text: string; truncated: boolean } {
  const raw = readFileSync(path);
  if (raw.length <= MAX_TEXT_BYTES) return { text: raw.toString('utf8'), truncated: false };
  return { text: `${raw.subarray(0, MAX_TEXT_BYTES).toString('utf8')}\n\n[truncated to ${MAX_TEXT_BYTES} bytes of ${raw.length} total]`, truncated: true };
}

/** Each page's text under a `--- page N ---` header, cut at the byte cap on a character boundary. */
async function readPdf(path: string, rel: string): Promise<{ text: string; truncated: boolean }> {
  const pages = await pdfPages(new Uint8Array(readFileSync(path)), rel);
  const joined = pages.map((text, i) => `--- page ${i + 1} ---\n${text.trim()}`).join('\n\n');
  const bytes = Buffer.from(joined);
  if (bytes.length <= MAX_TEXT_BYTES) return { text: joined, truncated: false };
  let cut = MAX_TEXT_BYTES;
  while ((bytes[cut] ?? 0) >> 6 === 0b10) cut--; // never end inside a multi-byte character
  return { text: `${bytes.subarray(0, cut).toString('utf8')}\n\n[truncated to ${MAX_TEXT_BYTES} bytes; PDF has ${pages.length} pages total]`, truncated: true };
}

/** A PDF that opens without a password (an empty one included) yields one string per page. */
async function pdfPages(data: Uint8Array, rel: string): Promise<string[]> {
  try {
    const pdf = await getDocumentProxy(data, { verbosity: 0 });
    try {
      return (await extractText(pdf)).text;
    } finally {
      await pdf.loadingTask.destroy();
    }
  } catch (err) {
    if ((err as Error).name === 'PasswordException') throw new Error(`PDF ${rel} is password-protected; cannot read`, { cause: err });
    throw new Error(`could not parse PDF ${rel}: ${(err as Error).message}`, { cause: err });
  }
}
