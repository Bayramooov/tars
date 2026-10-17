import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderSkillsIndex, SkillsStore } from '../../src/stores/skills.ts';
import { loadGolden } from '../golden/load.ts';
import { tempDir } from '../helpers/tmp.ts';

const MAX = 256 * 1024;
const valid = (name: string) => `---\nname: ${name}\ndescription: A test skill used by the SkillsStore test suite.\n---\n\n# ${name}\n\nBody content.\n`;
const DESCRIPTION = 'A test skill used by the SkillsStore test suite.';

function skill(root: string, dir: string, content: string | Buffer): void {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, 'SKILL.md'), content);
}

/** Two valid skills (one with a README beside it) and a directory without SKILL.md. */
function setup(disabled?: Set<string>) {
  const root = join(tempDir(), 'skills');
  skill(root, 'self-reflection', valid('self-reflection'));
  writeFileSync(join(root, 'self-reflection', 'README.md'), 'readme\n');
  skill(root, 'another', valid('another'));
  mkdirSync(join(root, 'docs-only'));
  writeFileSync(join(root, 'docs-only', 'notes.md'), 'notes\n');
  return { root, store: new SkillsStore(root, disabled) };
}

const names = (store: SkillsStore) => store.list().map((s) => s.name);

describe('SkillsStore.list', () => {
  it('lists only directories with a valid SKILL.md, by name, with their descriptions', () => {
    const { store } = setup();
    expect(store.list()).toEqual([
      { name: 'another', description: DESCRIPTION },
      { name: 'self-reflection', description: DESCRIPTION },
    ]);
  });

  it('silently skips a skill with broken frontmatter or a name that does not match its directory', () => {
    const { root, store } = setup();
    writeFileSync(join(root, 'another', 'SKILL.md'), '# No frontmatter here\n');
    expect(names(store)).toEqual(['self-reflection']);
    writeFileSync(join(root, 'another', 'SKILL.md'), valid('totally-different'));
    expect(names(store)).toEqual(['self-reflection']);
  });

  it('says why each skipped SKILL.md was left out', () => {
    const { root, store } = setup();
    expect(store.problems()).toEqual([]);
    writeFileSync(join(root, 'another', 'SKILL.md'), '# No frontmatter here\n');
    skill(root, 'binary', Buffer.from([0xff, 0xfe]));
    expect(store.problems()).toEqual([
      "another: SKILL.md must start with YAML frontmatter delimiter '---'",
      expect.stringMatching(/^binary: /) as string,
    ]);
  });

  it('is empty when the root does not exist', () => {
    expect(new SkillsStore(join(tempDir(), 'does-not-exist')).list()).toEqual([]);
  });

  it('skips symlinked skill directories, symlinked SKILL.md files, hidden directories and plain files', () => {
    const { root, store } = setup();
    const outside = join(tempDir(), 'outside');
    skill(outside, 'linked', valid('linked'));
    symlinkSync(join(outside, 'linked'), join(root, 'linked'));
    mkdirSync(join(root, 'md-link'));
    symlinkSync(join(outside, 'linked', 'SKILL.md'), join(root, 'md-link', 'SKILL.md'));
    skill(root, '.hidden', valid('.hidden'));
    writeFileSync(join(root, 'file.md'), valid('file.md'));
    expect(names(store)).toEqual(['another', 'self-reflection']);
  });

  it('lists CRLF and lone-CR SKILL.md files too, with trimmed descriptions', () => {
    const { root, store } = setup();
    skill(root, 'crlf', valid('crlf').replaceAll('\n', '\r\n'));
    skill(root, 'cr', valid('cr').replaceAll('\n', '\r'));
    skill(root, 'padded', '---\nname: padded\ndescription: "  padded both  "\n---\n');
    expect(store.list()).toEqual([
      { name: 'another', description: DESCRIPTION },
      { name: 'cr', description: DESCRIPTION },
      { name: 'crlf', description: DESCRIPTION },
      { name: 'padded', description: 'padded both' },
      { name: 'self-reflection', description: DESCRIPTION },
    ]);
  });

  it('skips a SKILL.md that is not UTF-8 instead of failing the whole listing', () => {
    const { root, store } = setup();
    skill(root, 'broken', Buffer.concat([Buffer.from('---\nname: broken\ndescription: bad '), Buffer.from([0xff]), Buffer.from('\n---\n')]));
    expect(names(store)).toEqual(['another', 'self-reflection']);
    expect(renderSkillsIndex(store)).toContain('- **another** — ');
  });

  it('hides skills_disabled names', () => {
    expect(names(setup().store)).toEqual(['another', 'self-reflection']);
    expect(names(setup(new Set(['another'])).store)).toEqual(['self-reflection']);
  });
});

describe('SkillsStore.read', () => {
  it('returns the whole SKILL.md, frontmatter included', () => {
    expect(setup().store.read('self-reflection')).toBe(valid('self-reflection'));
  });

  it('reports unknown and disabled skills as not found', () => {
    const { store } = setup(new Set(['another']));
    expect(() => store.read('does-not-exist')).toThrow('skill not found: does-not-exist');
    expect(() => store.read('another')).toThrow('skill not found: another');
    expect(() => store.read('Foo Bar')).toThrow('skill not found: Foo Bar');
  });

  it.each([
    ['# No frontmatter\n', "SKILL.md must start with YAML frontmatter delimiter '---'"],
    ['---\ndescription: No name field\n---\n\nbody\n', "SKILL.md frontmatter must include a non-empty 'name' field"],
    ['---\nname: self-reflection\n---\n\nbody\n', "SKILL.md frontmatter must include a non-empty 'description' field"],
    [`---\nname: self-reflection\ndescription: ${'x'.repeat(1100)}\n---\n`, 'SKILL.md description exceeds 1024 chars (1100)'],
    ['---\nname: Self-Reflection\ndescription: bad name case.\n---\n', "skill name 'Self-Reflection' must be lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens"],
    ['---\nname: other\ndescription: d\n---\n', "skill name 'other' in frontmatter must match parent directory 'self-reflection'"],
  ])('rejects an invalid SKILL.md: %j', (content, message) => {
    const { root, store } = setup();
    writeFileSync(join(root, 'self-reflection', 'SKILL.md'), content);
    expect(() => store.read('self-reflection')).toThrow(message);
  });

  it.each(['-badname', 'bad--name', 'trail-'])('rejects the hyphen rules: %s', (name) => {
    const { root, store } = setup();
    skill(root, name, `---\nname: ${name}\ndescription: hyphens.\n---\n`);
    expect(() => store.read(name)).toThrow(`skill name '${name}' must be lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens`);
  });

  it('refuses names that are not one directory under skills/', () => {
    const { store } = setup();
    expect(() => store.read('')).toThrow('skill name must be a non-empty string');
    expect(() => store.read('/etc/passwd')).toThrow('skill name must be relative, got "/etc/passwd"');
    expect(() => store.read('../something')).toThrow(`skill name may not contain '..': "../something"`);
    expect(() => store.read('self-reflection/SKILL.md')).toThrow('skill name must be a single directory name, got "self-reflection/SKILL.md"');
    expect(() => store.read("it's/x")).toThrow(`skill name must be a single directory name, got "it's/x"`);
    expect(() => store.read('.')).toThrow('skill name must be a single directory name, got "."');
    // "." components vanish, so "./x" is one directory name — which then fails the directory-name match.
    expect(() => store.read('./another')).toThrow("skill name 'another' in frontmatter must match parent directory './another'");
  });

  it('refuses a symlinked skill directory', () => {
    const { root, store } = setup();
    const outside = join(tempDir(), 'outside');
    skill(outside, 'evil', valid('evil'));
    symlinkSync(join(outside, 'evil'), join(root, 'evil'));
    expect(() => store.read('evil')).toThrow(`symlink in skill path: ${realpathSync(root)}/evil`);
  });

  it('cuts at 256 KiB (a split character becomes U+FFFD) and says so', () => {
    const { root, store } = setup();
    const head = '---\nname: self-reflection\ndescription: big body.\n---\n';
    const body = 'y'.repeat(MAX - Buffer.byteLength(head) - 2);
    writeFileSync(join(root, 'self-reflection', 'SKILL.md'), `${head}${body}€ and more`);
    expect(store.read('self-reflection')).toBe(`${head}${body}\u{FFFD}\n\n[truncated to 262144 bytes]`);
  });
});

describe('SkillsStore.write', () => {
  it('creates a new skill that is readable and listed at once, returning UTF-8 bytes written', () => {
    const { store } = setup();
    const content = `${valid('weekly-digest')}Oʻzbek 👍\n`;
    expect(store.write('weekly-digest', content)).toBe(Buffer.byteLength(content));
    expect(store.read('weekly-digest')).toBe(content);
    expect(names(store)).toContain('weekly-digest');
  });

  it('rejects bad frontmatter, a name mismatch and content over the cap', () => {
    const { store } = setup();
    expect(() => store.write('weekly-digest', '# no frontmatter here\n')).toThrow("SKILL.md must start with YAML frontmatter delimiter '---'");
    expect(() => store.write('weekly-digest', valid('something-else'))).toThrow("skill name 'something-else' in frontmatter must match parent directory 'weekly-digest'");
    const big = valid('big') + 'z'.repeat(MAX);
    expect(() => store.write('big', big)).toThrow(`content exceeds cap: ${Buffer.byteLength(big)} bytes > 262144`);
    const atCap = valid('at-cap') + 'z'.repeat(MAX - Buffer.byteLength(valid('at-cap')));
    expect(store.write('at-cap', atCap)).toBe(MAX);
  });

  it('overwrites an existing skill only after a successful read since boot', () => {
    const { root, store } = setup();
    expect(() => store.write('another', valid('another'))).toThrow("call skill_read('another') before overwriting it");
    writeFileSync(join(root, 'another', 'SKILL.md'), '# broken\n');
    expect(() => store.read('another')).toThrow();
    expect(() => store.write('another', valid('another'))).toThrow("call skill_read('another') before overwriting it");
    writeFileSync(join(root, 'another', 'SKILL.md'), valid('another'));
    store.read('another');
    expect(store.write('another', `${valid('another')}v2\n`)).toBeGreaterThan(0);
    expect(store.write('another', `${valid('another')}v3\n`)).toBeGreaterThan(0);
    const restarted = new SkillsStore(root);
    expect(() => restarted.write('another', valid('another'))).toThrow("call skill_read('another') before overwriting it");
  });

  it('lets the bot rewrite self-reflection too, after reading it', () => {
    const { store } = setup();
    store.read('self-reflection');
    expect(store.write('self-reflection', valid('self-reflection'))).toBe(Buffer.byteLength(valid('self-reflection')));
  });

  it('checks the name before the content', () => {
    const { store } = setup();
    expect(() => store.write('../evil', 'anything')).toThrow(`skill name may not contain '..': "../evil"`);
    expect(() => store.write('nested/SKILL.md', 'anything')).toThrow('skill name must be a single directory name, got "nested/SKILL.md"');
    expect(() => store.write('/etc/passwd', 'anything')).toThrow('skill name must be relative, got "/etc/passwd"');
  });

  // tmp + rename, so a crash can't leave half a playbook.
  it('writes atomically, creating the skills root if needed and leaving no tmp file', () => {
    const root = join(tempDir(), 'fresh', 'skills');
    const store = new SkillsStore(root);
    store.write('first', valid('first'));
    expect(readdirSync(join(root, 'first'))).toEqual(['SKILL.md']);
    expect(readFileSync(join(root, 'first', 'SKILL.md'), 'utf8')).toBe(valid('first'));
  });

  // Some regex dialects let `$` match before a final "\n"; the name rule must not.
  it('rejects a name ending in a newline', () => {
    const { root, store } = setup();
    expect(() => store.write('abc\n', '---\nname: "abc\\n"\ndescription: d\n---\n')).toThrow(
      "skill name 'abc\n' must be lowercase alphanumeric with hyphens, no leading/trailing/consecutive hyphens",
    );
    expect(existsSync(join(root, 'abc\n'))).toBe(false);
  });
});

describe('renderSkillsIndex', () => {
  interface ArgvGolden {
    cases: { label: string; resume: boolean; argv: string[] }[];
  }
  const golden = loadGolden<ArgvGolden>('argv.json');

  /** The "# Available skills" block of a golden case's composed system prompt. */
  function goldenBlock(label: string): string {
    const argv = golden.cases.find((c) => c.label === label && !c.resume)?.argv ?? [];
    const prompt = argv[argv.indexOf('--system-prompt') + 1] ?? '';
    return prompt.slice(prompt.indexOf('# Available skills'), prompt.indexOf('\n\n# Your memory'));
  }

  /** The skills the golden prompts were rendered from. */
  function captureSkills(): string {
    const root = join(tempDir(), 'skills');
    skill(root, 'alpha', '---\nname: alpha\ndescription: First skill — does A\n---\n\nBody of alpha.\n');
    skill(root, 'beta', '---\nname: beta\ndescription: Second skill\n---\n\nBody of beta.\n');
    return root;
  }

  it('renders byte for byte the block in the golden system prompt', () => {
    const root = captureSkills();
    expect(goldenBlock('missing-file')).toContain('- **beta** — Second skill');
    expect(renderSkillsIndex(new SkillsStore(root))).toBe(goldenBlock('missing-file'));
    expect(renderSkillsIndex(new SkillsStore(root, new Set(['beta'])))).toBe(goldenBlock('disabled-tools-and-skills'));
  });

  it('is empty when there are no skills, so no dangling header is appended', () => {
    const root = join(tempDir(), 'skills');
    mkdirSync(root);
    expect(renderSkillsIndex(new SkillsStore(root))).toBe('');
    expect(renderSkillsIndex(new SkillsStore(join(root, 'missing')))).toBe('');
  });
});
