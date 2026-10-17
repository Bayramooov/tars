import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, utimesSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { writeAtomic } from './atomic.ts';

/** 10× a typical project.md: room to grow, yet a runaway append can't fill the disk. */
const MAX_INSTRUCTION_BYTES = 128 * 1024;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A committed edit: the new size and the absolute path of the backup taken before it. */
interface Change {
  bytes: number;
  backup: string;
}

/**
 * `prompts/project.md`, the owner-curated overlay appended to system.md
 * (which is git-tracked and never exposed). The file must already exist.
 * Every change is capped, backed up to `prompt_backups/` first, then
 * written atomically.
 */
export class InstructionsStore {
  private readonly path: string;
  private readonly backupDir: string;

  constructor(path: string, backupDir: string) {
    // Canonical, so a symlinked project.md is edited in its target.
    this.path = existsSync(path) ? realpathSync(path) : resolve(path);
    this.backupDir = backupDir;
  }

  /** The file as text: strict UTF-8, every newline as `\n`. */
  read(): string {
    this.requireFile();
    return STRICT_UTF8.decode(readFileSync(this.path)).replace(/\r\n?/g, '\n');
  }

  /** Append `content` as is (no newline added). */
  append(content: string): Change {
    this.requireFile();
    return this.commit(Buffer.concat([readFileSync(this.path), Buffer.from(content)]), 'append');
  }

  /** Replace the whole file — how a rule is removed, which append can't do. */
  rewrite(content: string): Change {
    this.requireFile();
    return this.commit(Buffer.from(content), 'rewrite');
  }

  private requireFile(): void {
    if (!existsSync(this.path)) throw new Error(`project.md not present at ${this.path}`);
  }

  private commit(bytes: Buffer, op: string): Change {
    if (bytes.length > MAX_INSTRUCTION_BYTES) throw new Error(`${op} would exceed cap: ${bytes.length} bytes > ${MAX_INSTRUCTION_BYTES}`);
    const backup = this.backup();
    writeAtomic(this.path, bytes);
    return { bytes: bytes.length, backup };
  }

  /** `project-<UTC %Y%m%dT%H%M%S>Z.md`, keeping the file's timestamps; a same-second backup is overwritten. */
  private backup(): string {
    mkdirSync(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const backup = join(realpathSync(this.backupDir), `project-${stamp}Z.md`);
    copyFileSync(this.path, backup);
    const { atime, mtime } = statSync(this.path);
    utimesSync(backup, atime, mtime);
    return backup;
  }
}
