import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { parseFrontmatter, renderFrontmatter, requireNameAndDescription } from '../text/frontmatter.ts';
import { writeAtomic } from './atomic.ts';
import { resolveUnderRoot } from './paths.ts';

/** Cap on one memory file in UTF-8 bytes: for writes, appends and read truncation. */
const MAX_MEMORY_BYTES = 64 * 1024;
const LABEL = 'memory file';

interface MemoryFile {
  /** Full project path, `memories/…`. */
  path: string;
  /** Size in bytes. */
  size: number;
  /** The frontmatter description; undefined for a legacy file without one. */
  description: string | undefined;
}

interface MemoryHit {
  path: string;
  lineNumber: number;
  /** The matching line, stripped. */
  line: string;
  /** How many query terms the line contains; hits rank by it. */
  score: number;
}

/**
 * The bot's memory: files under one root, addressed as `memories/<path>`
 * wherever the root physically lives. Paths are hardened like every store's.
 * An existing file can be overwritten or appended to only after this store
 * has read or written it (read-before-write: the model can't destroy notes it
 * never saw); new files are exempt and the record lasts as long as the
 * process. Methods are synchronous, so a read-modify-write never interleaves
 * with another call.
 */
export class MemoryStore {
  private readonly root: string;
  private readonly readPaths = new Set<string>();

  constructor(root: string) {
    // Canonical, so error texts name the real path.
    this.root = existsSync(root) ? realpathSync(root) : resolve(root);
  }

  list(): MemoryFile[] {
    return this.files().map(({ path, file }) => ({ path, size: statSync(file).size, description: readDescription(file) }));
  }

  /** A file's text (UTF-8, bad bytes as U+FFFD), cut at the cap with a marker; unlocks writing it. */
  read(relative: string): string {
    const file = this.resolveReadable(relative);
    const raw = readFileSync(file);
    const marker = raw.length > MAX_MEMORY_BYTES ? `\n\n[truncated to ${MAX_MEMORY_BYTES} bytes]` : '';
    const text = raw.subarray(0, MAX_MEMORY_BYTES).toString('utf8') + marker;
    this.readPaths.add(file);
    return text;
  }

  /**
   * Lines containing at least one whitespace-separated term (case-insensitive),
   * those with more terms first. Not a read: searching never unlocks writing.
   */
  search(query: string, maxResults: number): MemoryHit[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    // Hits arrive in path and line order, which the stable sort keeps among equal scores.
    return this.files().flatMap(({ path }) => this.scan(path, terms)).sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  /** Create or overwrite a file whose content starts with `name`/`description` frontmatter; returns its size. */
  write(relative: string, content: string): number {
    requireNameAndDescription(parseFrontmatter(content, LABEL).meta, LABEL);
    const file = this.resolvePath(relative);
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_MEMORY_BYTES) throw new Error(`memory file too large: ${bytes} bytes > ${MAX_MEMORY_BYTES} cap`);
    this.existing(file, relative, 'overwrite');
    this.save(file, content);
    return bytes;
  }

  /**
   * Append to a file's body and replace its frontmatter with its name (kept,
   * or the file stem for a new or legacy file) and `description`; returns the
   * new size. The whole file is rewritten; other frontmatter keys are dropped.
   */
  append(relative: string, content: string, description: string): number {
    const file = this.resolvePath(relative);
    const { name, body } = this.nameAndBody(file, relative);
    requireNameAndDescription({ name, description }, LABEL);
    const text = `${renderFrontmatter({ name, description })}\n${body}${content}`;
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_MEMORY_BYTES) throw new Error(`append would exceed cap: ${bytes} bytes > ${MAX_MEMORY_BYTES}`);
    this.save(file, text);
    return bytes;
  }

  /** The absolute path of an existing memory file, for tools that ship it; not a read. */
  resolveReadable(relative: string): string {
    const file = this.resolvePath(relative);
    if (!isFile(file)) throw new Error(`memory file not found: ${relative}`);
    return file;
  }

  private resolvePath(relative: string): string {
    if (!relative.startsWith('memories/')) throw new Error(`memory path must start with 'memories/': got ${JSON.stringify(relative)}`);
    return resolveUnderRoot(this.root, relative.slice('memories/'.length), 'memory');
  }

  /** Every regular, not dot-named file reached without crossing a symlink, in path order. */
  private files(): { path: string; file: string }[] {
    if (!existsSync(this.root)) return [];
    const subpaths = walk(this.root, '').sort();
    return subpaths.map((sub) => ({ path: `memories/${sub}`, file: join(this.root, sub) }));
  }

  private scan(path: string, terms: string[]): MemoryHit[] {
    let text: string;
    try {
      text = readText(this.resolveReadable(path));
    } catch {
      return []; // gone or unreadable since it was listed
    }
    return text.split(/\r\n?|\n/).flatMap((line, i) => {
      const lowered = line.toLowerCase();
      const score = terms.filter((term) => lowered.includes(term)).length;
      return score ? [{ path, lineNumber: i + 1, line: line.trim(), score }] : [];
    });
  }

  /** Whether `file` exists; if it does, it must be a regular file this store has read or written. */
  private existing(file: string, relative: string, verb: string): boolean {
    if (!existsSync(file)) return false;
    if (!this.readPaths.has(file)) throw new Error(`refusing to ${verb} ${relative}: must call memory_read first in this session (read-before-write invariant)`);
    if (!isFile(file)) throw new Error(`${relative} exists but is not a regular file`);
    return true;
  }

  private nameAndBody(file: string, relative: string): { name: string; body: string } {
    const stem = pathStem(relative);
    if (!this.existing(file, relative, 'append to')) return { name: stem, body: '' };
    const text = readText(file);
    try {
      const { meta, body } = parseFrontmatter(text, LABEL);
      return { name: typeof meta.name === 'string' && meta.name ? meta.name : stem, body };
    } catch {
      return { name: stem, body: text }; // a legacy file: all of it is body
    }
  }

  private save(file: string, text: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeAtomic(file, Buffer.from(text));
    this.readPaths.add(file);
  }
}

/**
 * The "# Your memory" system-prompt block: every memory's path and
 * description, so the model knows what it knows from the first turn.
 * Empty when there are no memories.
 */
export function renderMemoryIndex(store: MemoryStore): string {
  const files = store.list();
  if (!files.length) return '';
  const lines = files.map((f) => `- \`${f.path}\`${f.description ? ` — ${f.description}` : ''}`);
  return (
    '# Your memory\n\n' +
    'Standing context you already hold — carried across restarts under memories/. Every file\'s path and one-line description is listed here so you know what you know before you reply; read a full file with memory_read("<path>") when one is relevant. memory_list re-fetches this same list and memory_search finds lines across files — use them when you suspect a file changed since this session started.\n\n' +
    `${lines.join('\n')}\n`
  );
}

/** Regular files under `dir` as POSIX subpaths. Symlinks are neither listed nor followed. */
function walk(dir: string, prefix: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const sub = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return walk(join(dir, entry.name), `${sub}/`);
    return entry.isFile() && !entry.name.startsWith('.') ? [sub] : [];
  });
}

/** Best effort: a legacy, malformed or unreadable file has no description instead of failing the listing. */
function readDescription(file: string): string | undefined {
  try {
    const { description } = parseFrontmatter(readText(file), LABEL).meta;
    return typeof description === 'string' ? description.trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

/** A file as text: bad bytes as U+FFFD, every newline as `\n`. */
const readText = (file: string) => readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');

const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

/** The last path component without its final suffix. */
function pathStem(path: string): string {
  const name = path.split('/').filter((part) => part && part !== '.').at(-1) ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(0, dot) : name;
}
