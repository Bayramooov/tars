import { z } from 'zod';

import { defineTool, storeResult, type Tool } from '../mcp/tool.ts';
import type { MemoryStore } from '../stores/memory.ts';

// The memory tools. There is deliberately no delete tool: forgetting means
// overwriting, and removing files stays an operator action.

export function memoryAppendTool(store: MemoryStore): Tool {
  return defineTool({
    name: 'memory_append',
    description: 'Append text to a memory file\'s body AND refresh its one-line description (kept in frontmatter) so memory_list always reflects the latest content. The file\'s name is preserved (or derived from the filename for a new/legacy file — the first append adds frontmatter). New total must stay under 64 KiB. If the file already exists you MUST call memory_read on it first in the same session. Appends go to \'memories/...\'. Useful for journals, running notes, conversation logs.',
    args: z.object({
      path: z.string().describe('Full project path under \'memories/\'. The \'memories/\' prefix is REQUIRED; a bare path is rejected. No \'..\', no absolute paths.'),
      content: z.string().describe('Text to append to the body. A trailing newline is NOT added.'),
      description: z.string().describe('Fresh one-line summary of what the file holds after this append. Replaces the file\'s frontmatter description so memory_list stays current. Max 1024 chars.'),
    }),
    run: ({ path, content, description }) =>
      storeResult(() => {
        const bytes = store.append(path, content, description);
        return { content: `appended; ${path} is now ${bytes} bytes`, data: { path, bytes } };
      }),
  });
}

export function memoryListTool(store: MemoryStore): Tool {
  return defineTool({
    name: 'memory_list',
    description: 'List every memory file, each shown by its FULL project path (\'memories/...\') with its frontmatter description, enough to decide which memory is relevant without reading the whole file (the same progressive-disclosure protocol skill_list uses). Pass a path from this list verbatim to memory_read/write/append. Memories carry name/description frontmatter; legacy files without it show just their path and size. To find files by their CONTENTS rather than their summaries, use memory_search instead.',
    args: z.object({}),
    run: () => {
      const files = store.list();
      if (!files.length) return Promise.resolve({ content: '(no memory files)' });
      const lines = files.map((f) => (f.description ? `- ${f.path} — ${f.description}` : `- ${f.path}\t${f.size} bytes (no description)`));
      const data = { files: files.map((f) => ({ path: f.path, description: f.description ?? null })) };
      return Promise.resolve({ content: lines.join('\n'), data });
    },
  });
}

export function memoryReadTool(store: MemoryStore): Tool {
  return defineTool({
    name: 'memory_read',
    description: 'Read ONE memory file by its full project path (\'memories/...\'). Pass the exact path from memory_list/memory_search; a wrong path just fails, it does not fall back. To read several files, call this once per path (the calls can run in parallel). UTF-8; files over 64 KiB are truncated. Reading a file unlocks writing/appending to it this session.',
    args: z.object({
      path: z.string().describe('EXACT full project path, copied verbatim from memory_list or memory_search — do not retype or guess it. Starts with \'memories/\'. The prefix is REQUIRED. No \'..\', no absolute paths.'),
    }),
    run: ({ path }) => storeResult(() => ({ content: store.read(path), data: { path } })),
  });
}

export function memorySearchTool(store: MemoryStore): Tool {
  return defineTool({
    name: 'memory_search',
    description: 'Search the TEXT INSIDE memory files (not just their names) for keywords, across all \'memories/\' files. Case-insensitive. Returns matching lines as \'path:line: text\', best matches first, where \'path\' is the full project path. Faster than memory_list plus reading every file: search first, then memory_read the most relevant file by copying its exact path from these results.',
    args: z.object({
      query: z.string().describe('Keywords to find inside memory file contents (case-insensitive). Use a few keywords, not a full sentence — e.g. \'acme deadline\', not \'when is the Acme deadline?\'. Lines matching more of your keywords rank higher.'),
      max_results: z.int().min(1).max(200).default(50).describe('Maximum number of matching lines to return.'),
    }),
    run: ({ query, max_results }) => {
      const hits = store.search(query, max_results);
      if (!hits.length) return Promise.resolve({ content: '(no matches)' });
      const lines = hits.map((h) => `${h.path}:${h.lineNumber}: ${h.line}`);
      return Promise.resolve({ content: lines.join('\n'), data: { hits: hits.map((h) => h.path) } });
    },
  });
}

export function memoryWriteTool(store: MemoryStore): Tool {
  return defineTool({
    name: 'memory_write',
    description: 'Create or fully overwrite a memory file under \'memories/...\'. Max 64 KiB. Content MUST start with name/description frontmatter (the template) — writes without it are rejected — so memory_list can show what the file is about. Rewrite the description whenever the content changes. If the file already exists you MUST call memory_read on it first in the same session — a safety rail against destroying notes whose content you never saw. New files can be created without a prior read. Conventional locations (match these, don\'t invent new structure): per-user profile → memories/notes/users/<telegram_user_id>.md; per-group behaviors → memories/notes/groups/<chat_id>.md; cross-session reference → memories/notes/<topic>.md; one-off report → memories/docs/<topic>-<YYYY-MM-DD>.md. Create per-user and per-group files lazily, after a few real exchanges. Writes to local storage only — to send a memory file to the user, use telegram_send_memory_document.',
    args: z.object({
      path: z.string().describe('Full project path under \'memories/\'. The \'memories/\' prefix is REQUIRED; a bare path is rejected. No \'..\', no absolute paths. Parent directories are created automatically.'),
      content: z.string().describe('Full new file body. Overwrites any existing content. MUST begin with the frontmatter template:\n---\nname: <short human-friendly label>\ndescription: <one-line summary used to find this memory without reading it>\n---\n\n<body — the actual remembered content>\n\nKeep the description a fresh one-line summary of what the file now holds.'),
    }),
    run: ({ path, content }) =>
      storeResult(() => {
        const bytes = store.write(path, content);
        return { content: `wrote ${bytes} bytes to ${path}`, data: { path, bytes } };
      }),
  });
}
