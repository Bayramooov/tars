import { describe, expect, it } from 'vitest';

import { expectGoldenTool, goldenRegistry as registry, goldenTools } from './tools.ts';

describe('MCP tools/list (golden)', () => {
  it('lists every tool in order, each with its snapshot name, description and schema', () => {
    const { tools } = registry();
    for (const tool of tools) expectGoldenTool(tool);
    expect(tools.map((t) => t.name)).toEqual(goldenTools.map((t) => t.name));
  });

  it('skips disabled tools and fails boot on an unknown name', () => {
    const { tools, log } = registry(['time_now']);
    expect(tools.map((t) => t.name)).not.toContain('time_now');
    expect(log.text()).toContain('skipped MCP tool time_now (disabled in plugins.json)');
    expect(() => registry(['nope'])).toThrow('plugins.json builtin_tools_disabled has unknown name(s): ["nope"]; available: [');
  });
});
