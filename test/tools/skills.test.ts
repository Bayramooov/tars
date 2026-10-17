import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ToolCallRow } from '../../src/db/toolcalls.ts';
import { McpHttpServer } from '../../src/mcp/server.ts';
import { SkillsStore } from '../../src/stores/skills.ts';
import { skillListTool, skillReadTool, skillWriteTool } from '../../src/tools/skills.ts';
import { expectGoldenTool } from '../golden/tools.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

const VALID = '---\nname: self-reflection\ndescription: A test skill for tool-level unit testing. This is what skill_list surfaces.\n---\n\n# self-reflection\n\nBody.\n';
const newSkill = (name: string) => `---\nname: ${name}\ndescription: A freshly written test skill.\n---\n\n# ${name}\n\nBody.\n`;

function setup() {
  const root = join(tempDir(), 'skills');
  mkdirSync(join(root, 'self-reflection'), { recursive: true });
  writeFileSync(join(root, 'self-reflection', 'SKILL.md'), VALID);
  const store = new SkillsStore(root);
  return { root, store, list: skillListTool(store), read: skillReadTool(store), write: skillWriteTool(store) };
}

describe('skill tools', () => {
  it('match the tools/list snapshot', () => {
    const t = setup();
    for (const tool of [t.list, t.read, t.write]) expectGoldenTool(tool);
  });

  it('skill_list returns each name and description', async () => {
    expect(await setup().list.run({})).toEqual({
      content: '- **self-reflection** — A test skill for tool-level unit testing. This is what skill_list surfaces.',
      data: { skills: [{ name: 'self-reflection', description: 'A test skill for tool-level unit testing. This is what skill_list surfaces.' }] },
    });
  });

  it('skill_list says so when there are no skills', async () => {
    const root = join(tempDir(), 'empty');
    mkdirSync(root);
    expect(await skillListTool(new SkillsStore(root)).run({})).toEqual({ content: '(no skills)' });
  });

  it('skill_read returns the full SKILL.md', async () => {
    expect(await setup().read.run({ name: 'self-reflection' })).toEqual({ content: VALID, data: { name: 'self-reflection' } });
  });

  it('skill_read reports store errors as error results', async () => {
    const { read } = setup();
    expect(await read.run({ name: 'does-not-exist' })).toEqual({ content: 'skill not found: does-not-exist', isError: true });
    expect(await read.run({ name: '../secrets' })).toEqual({ content: 'skill name may not contain \'..\': "../secrets"', isError: true });
  });

  it('skill_write creates a skill and reports the bytes written', async () => {
    const { store, write } = setup();
    const content = newSkill('weekly-digest');
    expect(await write.run({ name: 'weekly-digest', content })).toEqual({
      content: `wrote ${Buffer.byteLength(content)} bytes to skills/weekly-digest/SKILL.md. Restart the container to refresh the preloaded skills index.`,
      data: { name: 'weekly-digest', bytes: Buffer.byteLength(content) },
    });
    expect(store.read('weekly-digest')).toBe(content);
  });

  it('skill_write rejects bad frontmatter and unread overwrites', async () => {
    const { write } = setup();
    expect(await write.run({ name: 'weekly-digest', content: '# no frontmatter\n' })).toEqual({
      content: "SKILL.md must start with YAML frontmatter delimiter '---'",
      isError: true,
    });
    expect(await write.run({ name: 'self-reflection', content: VALID })).toEqual({
      content: "call skill_read('self-reflection') before overwriting it",
      isError: true,
    });
  });

  it('reach the model as error results, audited as results (no error log, no owner DM)', async () => {
    const { read } = setup();
    const log = memoryLogger();
    const rows: ToolCallRow[] = [];
    const server = new McpHttpServer({ tools: [read], log, beat: () => {}, audit: (row) => void rows.push(row) });
    expect(await server.call('skill_read', { name: 'nope' })).toEqual({
      content: [{ type: 'text', text: 'skill not found: nope' }],
      isError: true,
    });
    expect(rows).toMatchObject([{ toolName: 'skill_read', args: { name: 'nope' }, result: { content: 'skill not found: nope' }, error: undefined }]);
    expect(log.records.filter((r) => r.level === 'ERROR')).toEqual([]);
  });
});
