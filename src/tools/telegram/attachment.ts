import { z } from 'zod';

import { defineTool, type Tool, type ToolResult } from '../../mcp/tool.ts';
import type { Attachment, AttachmentStore } from '../../stores/attachments.ts';

/**
 * Reads what a user sent (saved by the dispatcher): images come back as an
 * image block, text files and PDFs as text. Every failure is a handled
 * error result — the model asked for a path that isn't readable.
 */
export function readAttachmentTool(store: Pick<AttachmentStore, 'relativePath' | 'read'>): Tool {
  return defineTool({
    name: 'telegram_read_attachment',
    description: 'Read a Telegram attachment that the user sent. Inbound photos and documents are saved under data/attachments/ by the dispatcher and surfaced as ``[attachment: <path> ...]`` markers in the user\'s message. Pass that path here. Images are returned as image content blocks (so you can actually see them); text-like files (md, txt, log, csv, json, yaml, code, ...) are returned as UTF-8 text. PDFs are returned as their text, with ``--- page N ---`` markers.',
    args: z.object({
      path: z.string().describe('Either the absolute path printed in the inbound ``[attachment: ...]`` marker, or a path relative to ``data/attachments/``. Path traversal (``..``) and symlinks are rejected.'),
    }),
    run: async ({ path }) => {
      const rel = store.relativePath(path);
      if (rel === undefined) return { content: `path is not under attachments root: ${path}`, isError: true };
      try {
        return result(rel, await store.read(rel));
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
    },
  });
}

function result(rel: string, a: Attachment): ToolResult {
  switch (a.kind) {
    case 'unsupported':
      return { content: `attachment ${rel} has unsupported kind for reading`, isError: true };
    case 'image':
      return { content: `image attachment ${rel} (${a.mime}, ${a.sizeBytes} bytes)`, data: { path: a.path, mime: a.mime, size_bytes: a.sizeBytes }, imagePath: a.path };
    case 'text':
      return { content: a.text, data: { path: rel, size_bytes: a.sizeBytes, truncated: a.truncated } };
    case 'pdf':
      return { content: a.text, data: { path: rel, size_bytes: a.sizeBytes, truncated: a.truncated, kind: 'pdf' } };
  }
}
