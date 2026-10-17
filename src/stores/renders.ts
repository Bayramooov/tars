import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveUnderRoot } from './paths.ts';

/**
 * `data/renders/`: the PNGs render_html/render_latex draw and the browser's
 * screenshots and downloads, flat, named `{UTC stamp}-{slug}-{6 hex}.png`.
 * Tools return the bare name; telegram_send_photo resolves it back. Boot
 * deletes renders untouched for 30 days.
 */
export class RenderStore {
  /** Canonical root, so containment checks see through symlinked parents. */
  readonly root: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.root = realpathSync(dir);
  }

  /** Write `bytes` under a fresh name (slugged from `title`) and return that name. */
  save(title: string | null, bytes: Uint8Array): string {
    const slug = slugify(title);
    const name = `${utcStamp()}-${slug ? `${slug}-` : ''}${randomBytes(3).toString('hex')}.png`;
    mkdirSync(this.root, { recursive: true }); // survives an operator deleting the directory
    writeFileSync(join(this.root, name), bytes);
    return name;
  }

  /** The absolute path of a render name; an unsafe one throws. */
  resolvePath(relative: string): string {
    return resolveUnderRoot(this.root, relative, 'render');
  }

  isFile(path: string): boolean {
    return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
  }
}

/** Lowercase, each run outside `[a-z0-9]` becomes `-`, outer `-` trimmed, then cut to 40 (a cut can leave a trailing `-`). */
function slugify(title: string | null): string {
  if (!title) return '';
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** `20261017T143005`: UTC, to the second. */
const utcStamp = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
