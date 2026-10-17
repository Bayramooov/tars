import { describe, expect, it } from 'vitest';

import { goldenRegistry } from '../golden/tools.ts';

describe('tool_list', () => {
  it('lists the enabled tools sorted by name, one line each with its description', async () => {
    const { tools } = goldenRegistry(['time_now']);
    const list = tools.find((t) => t.name === 'tool_list');
    const lines = ((await list?.run({}))?.content.split('\n') ?? []).filter((l) => l.startsWith('- **mcp__tars__'));
    expect(lines).toHaveLength(tools.length);
    expect(lines[0]).toMatch(/^- \*\*mcp__tars__browser_back\*\* — /);
    expect(lines.some((l) => l.includes('time_now'))).toBe(false);
    const names = lines.map((l) => /^- \*\*mcp__tars__(\w+)\*\*/.exec(l)?.[1] ?? '');
    expect(names).toEqual([...names].sort());
  });
});
