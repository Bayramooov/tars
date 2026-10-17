import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { parseFrontmatter, requireNameAndDescription } from '../text/frontmatter.ts';
import { writeAtomic } from './atomic.ts';
import { resolveUnderRoot } from './paths.ts';

/** Playbooks can be long: 4× a memory file. */
const MAX_SKILL_BYTES = 256 * 1024;
/** Agent Skills names: lowercase letters and digits, single hyphens only between them. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** A skill as the catalogue shows it: frontmatter metadata, never the body. */
interface SkillFile {
  name: string;
  description: string;
}

interface BrokenSkill {
  name: string;
  error: string;
}

/**
 * Agent skill playbooks at `skills/<name>/SKILL.md` (agentskills.io spec).
 * Only first-level directories holding a real (non-symlinked) SKILL.md with
 * valid frontmatter count. Names in `disabled` (plugins.json
 * `skills_disabled`) are invisible to `list` and `read`. Overwriting a skill
 * needs a `read` of it first since boot.
 */
export class SkillsStore {
  private readonly root: string;
  private readonly disabled: ReadonlySet<string>;
  /** The read-before-write gate: names read or written since boot. */
  private readonly readNames = new Set<string>();

  constructor(root: string, disabled: ReadonlySet<string> = new Set()) {
    // Canonical; the root may not exist yet.
    this.root = existsSync(root) ? realpathSync(root) : resolve(root);
    this.disabled = disabled;
  }

  /** Every valid skill, by name. A broken skill is left out, never fatal; `problems` says why. */
  list(): SkillFile[] {
    return this.entries().flatMap((entry) => ('description' in entry ? [entry] : []));
  }

  /** `<name>: <reason>` for every SKILL.md that `list` leaves out because it doesn't read or validate. */
  problems(): string[] {
    return this.entries().flatMap((entry) => ('error' in entry ? [`${entry.name}: ${entry.error}`] : []));
  }

  /** The whole SKILL.md, frontmatter included, cut at 256 KiB; it must still validate. */
  read(name: string): string {
    if (this.disabled.has(name)) throw new Error(`skill not found: ${name}`);
    const path = this.path(name);
    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) throw new Error(`skill not found: ${name}`);
    const bytes = readFileSync(path);
    const text = bytes.subarray(0, MAX_SKILL_BYTES).toString('utf8');
    validateSkill(text, name);
    this.readNames.add(name);
    return bytes.length > MAX_SKILL_BYTES ? `${text}\n\n[truncated to ${MAX_SKILL_BYTES} bytes]` : text;
  }

  /** Create or overwrite a skill; returns the bytes written. `skills/` is git-tracked: git is the backup. */
  write(name: string, content: string): number {
    const path = this.path(name);
    validateSkill(content, name);
    const bytes = Buffer.from(content);
    if (bytes.length > MAX_SKILL_BYTES) throw new Error(`content exceeds cap: ${bytes.length} bytes > ${MAX_SKILL_BYTES}`);
    if (existsSync(path) && !this.readNames.has(name)) throw new Error(`call skill_read('${name}') before overwriting it`);
    mkdirSync(dirname(path), { recursive: true });
    writeAtomic(path, bytes);
    this.readNames.add(name);
    return bytes.length;
  }

  private entries(): (SkillFile | BrokenSkill)[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .sort()
      .flatMap((name) => this.entry(name) ?? []);
  }

  private entry(name: string): SkillFile | BrokenSkill | undefined {
    if (name.startsWith('.') || this.disabled.has(name)) return undefined;
    const dir = join(this.root, name);
    const file = join(dir, 'SKILL.md');
    // lstat: a symlinked skill directory or SKILL.md never counts.
    if (!lstatSync(dir).isDirectory() || !lstatSync(file, { throwIfNoEntry: false })?.isFile()) return undefined;
    try {
      // Strict UTF-8, every newline as \n.
      const text = STRICT_UTF8.decode(readFileSync(file)).replace(/\r\n?/g, '\n');
      return { name, description: validateSkill(text, name).trim() };
    } catch (err) {
      // One unreadable or malformed skill must not hide the valid ones.
      return { name, error: (err as Error).message };
    }
  }

  /** `skills/<name>/SKILL.md` for a single-component name; traversal and symlinks are refused. */
  private path(name: string): string {
    if (!name) throw new Error('skill name must be a non-empty string');
    if (isAbsolute(name)) throw new Error(`skill name must be relative, got ${JSON.stringify(name)}`);
    // Empty and "." components vanish, ".." stays.
    const parts = name.split('/').filter((part) => part && part !== '.');
    if (parts.includes('..')) throw new Error(`skill name may not contain '..': ${JSON.stringify(name)}`);
    if (parts.length !== 1) throw new Error(`skill name must be a single directory name, got ${JSON.stringify(name)}`);
    return resolveUnderRoot(this.root, `${name}/SKILL.md`, 'skill');
  }
}

/** Check a SKILL.md against the Agent Skills rules for directory `dirName`; returns the raw description. */
export function validateSkill(text: string, dirName: string): string {
  const { meta } = parseFrontmatter(text, 'SKILL.md');
  requireNameAndDescription(meta, 'SKILL.md');
  const name = meta.name as string;
  if (!NAME.test(name)) {
    throw new Error(`skill name '${name}' must be lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens`);
  }
  if (name !== dirName) throw new Error(`skill name '${name}' in frontmatter must match parent directory '${dirName}'`);
  return meta.description as string;
}

/**
 * The "# Available skills" system-prompt block: every skill's name and
 * description, so the model knows its playbooks without calling skill_list.
 * Empty when there are none, so the caller can append it unconditionally.
 */
export function renderSkillsIndex(store: SkillsStore): string {
  const skills = store.list();
  if (!skills.length) return '';
  const lines = skills.map((s) => `- **${s.name}** — ${s.description}`).join('\n');
  return (
    '# Available skills\n\n' +
    'These operator-curated playbooks live under skills/<name>/SKILL.md. ' +
    'Their names and descriptions are listed here so you always know what exists — ' +
    'load a full body with skill_read("<name>") when one is relevant. ' +
    'skill_list re-fetches this same list on demand.\n\n' +
    `${lines}\n`
  );
}
