import { z } from 'zod';

import { defineTool, type Tool } from '../mcp/tool.ts';

/** `tool_list`: the enabled tools by exact callable name, so the model can discover what it can do. */
export function toolListTool(enabled: () => readonly Tool[]): Tool {
  return defineTool({
    name: 'tool_list',
    description: 'List the tools currently available to you, with each tool\'s name and short description. Use it to discover what you can do, or to find tools related to a task before acting. Disabled tools are not listed.',
    args: z.object({}),
    run: () => {
      const listed = [...enabled()]
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((tool) => ({ name: `mcp__tars__${tool.name}`, description: tool.description }));
      if (!listed.length) return Promise.resolve({ content: '(no tools)' });
      const content = listed.map((t) => `- **${t.name}** — ${t.description}`).join('\n');
      return Promise.resolve({ content, data: { tools: listed } });
    },
  });
}
