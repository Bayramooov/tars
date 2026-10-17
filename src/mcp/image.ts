import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** A file as an MCP image block, so Claude actually sees the picture. */
export function imageContent(path: string): { type: 'image'; data: string; mimeType: string } {
  return { type: 'image', data: readFileSync(path).toString('base64'), mimeType: MIME[extname(path).toLowerCase()] ?? 'application/octet-stream' };
}
