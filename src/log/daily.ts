import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface DailyFile {
  write(text: string): void;
  close(): void;
}

/**
 * Append-only file rotated at local midnight: the live
 * file keeps its name, the finished day becomes `<name>.YYYY-MM-DD`, and only
 * the newest `backups` of those are kept. A file left over from an earlier
 * day is rotated on the first write after start.
 */
export function openDailyFile(path: string, backups = 7): DailyFile {
  mkdirSync(dirname(path), { recursive: true });
  let rolloverAt = nextMidnight(existsSync(path) ? statSync(path).mtime : new Date());
  let fd = openSync(path, 'a');
  return {
    write(text) {
      const now = new Date();
      if (now >= rolloverAt) {
        closeSync(fd);
        rotate(path, rolloverAt, backups);
        fd = openSync(path, 'a');
        rolloverAt = nextMidnight(now);
      }
      writeSync(fd, text);
    },
    close: () => closeSync(fd),
  };
}

function rotate(path: string, rolloverAt: Date, backups: number): void {
  const day = new Date(rolloverAt);
  day.setDate(day.getDate() - 1);
  const stamp = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
  const target = `${path}.${stamp}`;
  if (existsSync(target)) unlinkSync(target);
  if (existsSync(path)) renameSync(path, target);
  const prefix = `${basename(path)}.`;
  const rotated = readdirSync(dirname(path))
    .filter((name) => name.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}$/.test(name.slice(prefix.length)))
    .sort();
  for (const name of rotated.slice(0, Math.max(0, rotated.length - backups))) unlinkSync(join(dirname(path), name));
}

function nextMidnight(from: Date): Date {
  const next = new Date(from);
  next.setHours(24, 0, 0, 0);
  return next;
}

const pad = (n: number) => String(n).padStart(2, '0');
