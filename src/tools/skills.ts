import { z } from 'zod';

import { defineTool, storeResult, type Tool } from '../mcp/tool.ts';
import type { SkillsStore } from '../stores/skills.ts';

/** `skill_list`: every skill's name and description — enough to pick one without loading bodies. */
export function skillListTool(store: SkillsStore): Tool {
  return defineTool({
    name: 'skill_list',
    description: 'List available agent skills (playbooks) under the project\'s skills/ directory, following the Agent Skills spec (https://agentskills.io/specification). Returns each skill\'s name and its frontmatter description — enough to decide which skill is relevant without loading the full body. Fetch the body via skill_read only when you\'re ready to execute. Skills are typically invoked via `<skill name="X">run</skill>` inside a `<reminder>` envelope.',
    args: z.object({}),
    run: () => {
      const skills = store.list();
      if (!skills.length) return Promise.resolve({ content: '(no skills)' });
      const content = skills.map((s) => `- **${s.name}** — ${s.description}`).join('\n');
      return Promise.resolve({ content, data: { skills } });
    },
  });
}

/** `skill_read`: a skill's whole SKILL.md — the playbook to execute. */
export function skillReadTool(store: SkillsStore): Tool {
  return defineTool({
    name: 'skill_read',
    description: 'Read the playbook (SKILL.md) for a given agent skill. Returns the full markdown content. Call skill_list first if you\'re not sure what\'s available. Call this when a `<reminder>` envelope contains `<skill name="X">run</skill>`.',
    args: z.object({
      name: z.string().describe('Skill name (e.g. \'self-reflection\'). Must be a single directory name.'),
    }),
    run: ({ name }) => storeResult(() => ({ content: store.read(name), data: { name } })),
  });
}

/** `skill_write`: create or update a playbook. Owner-only by prompt policy, not by code. */
export function skillWriteTool(store: SkillsStore): Tool {
  return defineTool({
    name: 'skill_write',
    description: 'Create or update a skill playbook at skills/<name>/SKILL.md. Use ONLY when the bot owner has approved the new/updated playbook (e.g. via the self-reflection loop). Refuse for any non-owner sender. The content must carry valid frontmatter whose name matches <name>; max 256 KiB. Overwriting an existing skill requires calling skill_read on it first this session. Visible via skill_list/skill_read immediately; the preloaded skills index in your prompt refreshes on the next restart. skills/ is git-tracked — commit the result like a memory.',
    args: z.object({
      name: z.string().describe('Single-component skill directory name, e.g. \'weekly-digest\' (lowercase letters/digits/hyphens). The frontmatter `name` must equal this.'),
      content: z.string().describe('Full SKILL.md text. MUST start with YAML frontmatter carrying `name` (matching the name arg) and a one-line `description`, followed by the playbook body.'),
    }),
    run: ({ name, content }) =>
      storeResult(() => {
        const bytes = store.write(name, content);
        return {
          content: `wrote ${bytes} bytes to skills/${name}/SKILL.md. Restart the container to refresh the preloaded skills index.`,
          data: { name, bytes },
        };
      }),
  });
}
