import { mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { InstructionsStore } from '../../src/stores/instructions.ts';
import { instructionAppendTool, instructionReadTool, instructionRewriteTool } from '../../src/tools/instructions.ts';
import { expectGoldenTool } from '../golden/tools.ts';
import { tempDir } from '../helpers/tmp.ts';

function setup() {
  const dir = tempDir();
  const path = join(dir, 'prompts', 'project.md');
  mkdirSync(dirname(path));
  writeFileSync(path, 'PROJECT v1\n');
  const store = new InstructionsStore(path, join(dir, 'backups'));
  return { path, read: instructionReadTool(store), append: instructionAppendTool(store), rewrite: instructionRewriteTool(store) };
}

describe('instruction tools', () => {
  it('match the tools/list snapshot', () => {
    const t = setup();
    for (const tool of [t.append, t.read, t.rewrite]) expectGoldenTool(tool);
  });

  it('instruction_read returns project.md', async () => {
    expect(await setup().read.run({})).toEqual({ content: 'PROJECT v1\n' });
  });

  it('instruction_read reports a missing project.md as an error result', async () => {
    const { path, read } = setup();
    const real = realpathSync(path);
    unlinkSync(path);
    expect(await read.run({})).toEqual({ content: `project.md not present at ${real}`, isError: true });
  });

  it('instruction_append appends, names the backup and keeps the old body in it', async () => {
    const { path, append } = setup();
    const result = await append.run({ content: 'extra line\n' });
    const { bytes, backup } = result.data as { bytes: number; backup: string };
    expect(readFileSync(path, 'utf8')).toBe('PROJECT v1\nextra line\n');
    expect(result.content).toBe(`appended; project.md is now 22 bytes (backup: ${basename(backup)}). Restart the container to apply.`);
    expect(bytes).toBe(22);
    expect(basename(backup)).toMatch(/^project-\d{8}T\d{6}Z\.md$/);
    expect(readFileSync(backup, 'utf8')).toBe('PROJECT v1\n');
  });

  it('instruction_append reports the cap as an error result', async () => {
    const { path, append } = setup();
    writeFileSync(path, 'y'.repeat(131_000));
    expect(await append.run({ content: 'z'.repeat(200) })).toEqual({ content: 'append would exceed cap: 131200 bytes > 131072', isError: true });
  });

  it('instruction_rewrite replaces project.md and keeps the old body in the backup', async () => {
    const { path, rewrite } = setup();
    const result = await rewrite.run({ content: 'PROJECT v2 only\n' });
    const { backup } = result.data as { backup: string };
    expect(readFileSync(path, 'utf8')).toBe('PROJECT v2 only\n');
    expect(result.content).toBe(`rewrote; project.md is now 16 bytes (backup: ${basename(backup)}). Restart the container to apply.`);
    expect(readFileSync(backup, 'utf8')).toBe('PROJECT v1\n');
  });
});
