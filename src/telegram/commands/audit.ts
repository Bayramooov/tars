import { existsSync, readdirSync, type Stats, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import type { Db } from '../../db/database.ts';
import { cpSlice } from '../../text/clip.ts';

/** `/audit`: what has been happening — recent tool failures, prompt backups, memory size (legacy Markdown). */
export function auditText(db: Db, dirs: { dataDir: string; memoriesDir: string }): string {
  return ['*tars audit*', ...toolFailures(db), promptBackups(join(dirs.dataDir, 'prompt_backups')), memoryFootprint(dirs.memoriesDir)].join('\n');
}

// Each section reports its own failure instead of failing the readout.

function toolFailures(db: Db): string[] {
  let rows: { tool_name: string; error: string; created_at: string }[];
  try {
    rows = db
      .prepare("SELECT tool_name, error, created_at FROM tool_calls WHERE error IS NOT NULL AND error != '' ORDER BY id DESC LIMIT 5")
      .all() as typeof rows;
  } catch (err) {
    return [`*recent tool failures:* query error (${(err as Error).message})`];
  }
  if (!rows.length) return ['*recent tool failures:* none'];
  return ['*recent tool failures:*', ...rows.map((r) => `  • \`${r.created_at}\` ${r.tool_name} — ${cpSlice(r.error, 80).text}`)];
}

function promptBackups(dir: string): string {
  try {
    if (!existsSync(dir)) return '*prompt backups:* (none yet)';
    const files = readdirSync(dir).filter((name) => extname(name) === '.md' && fileStat(join(dir, name)));
    return `*prompt backups:* ${files.length} file(s) in \`${dir}\``;
  } catch (err) {
    return `*prompt backups:* error (${(err as Error).message})`;
  }
}

function memoryFootprint(dir: string): string {
  try {
    const bytes = existsSync(dir) ? treeBytes(dir) : 0;
    return `*memory footprint:* ${bytes.toLocaleString('en-US')} bytes under \`memories/\``;
  } catch (err) {
    return `*memory footprint:* error (${(err as Error).message})`;
  }
}

/** Size of the files under `dir`: a linked file counts, a linked directory is not entered. */
function treeBytes(dir: string): number {
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    bytes += entry.isDirectory() ? treeBytes(path) : (fileStat(path)?.size ?? 0);
  }
  return bytes;
}

/** A regular file's stats, symlinks followed; undefined for anything else (a dangling link included). */
function fileStat(path: string): Stats | undefined {
  const stats = statSync(path, { throwIfNoEntry: false });
  return stats?.isFile() ? stats : undefined;
}
