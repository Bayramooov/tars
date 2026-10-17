import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

import type { Logger } from '../log/logger.ts';

interface Sink {
  fd: number;
  name: string;
}

/**
 * Byte-faithful record of the Claude Code wire, for post-mortems (`data/cc_logs`):
 * `<dir>/<session>.stream.jsonl` gets every stdout line, `.stderr.log` every
 * stderr line with a local timestamp. Until the session id is known the
 * files are `pending-<ms>.*`; `system/init` renames them. Boot deletes
 * files untouched for 30 days.
 */
export class WireCapture {
  private stream: Sink | undefined;
  private stderr: Sink | undefined;
  private readonly dir: string;
  private readonly log: Logger;

  constructor(dir: string, log: Logger) {
    this.dir = dir;
    this.log = log;
  }

  open(sessionId: string | undefined): void {
    const prefix = sessionId || `pending-${Date.now()}`;
    try {
      mkdirSync(this.dir, { recursive: true });
      this.stream = this.openSink(`${prefix}.stream.jsonl`);
      this.stderr = this.openSink(`${prefix}.stderr.log`);
      this.log.info(`raw cc capture: stream=${prefix}.stream.jsonl stderr=${prefix}.stderr.log`);
    } catch (err) {
      this.log.error('failed to open cc raw-capture files; capture disabled', { err });
      this.close();
    }
  }

  writeStream(line: string): void {
    this.write(this.stream, `${line}\n`, 'failed to write to cc stream log');
  }

  writeStderr(line: string): void {
    this.write(this.stderr, `${localStamp(new Date())} ${line}\n`, 'failed to write to cc stderr log');
  }

  /** On `system/init`: rename `pending-*` files to the session id (appending when that file already exists). */
  sessionKnown(sessionId: string): void {
    const sinks = [this.stream, this.stderr];
    if (!this.stream?.name.startsWith('pending-') || !this.stderr) return;
    const pending = sinks.map((sink) => sink?.name ?? '');
    const named = pending.map((name) => name.replace(/^pending-\d+/, sessionId));
    this.close();
    try {
      pending.forEach((name, i) => moveOrAppend(join(this.dir, name), join(this.dir, named[i] ?? name)));
      this.log.info(`raw cc capture renamed to ${named[0]}`);
    } catch (err) {
      this.log.error('failed to rename raw cc capture files; keeping capture alive', { err });
    }
    // A pending file still there means its rename failed; otherwise write on under the session's name.
    const reopen = (i: number) => this.openSink(existsSync(join(this.dir, pending[i] ?? '')) ? (pending[i] ?? '') : (named[i] ?? ''));
    this.stream = reopen(0);
    this.stderr = reopen(1);
  }

  /** Close both files; one still empty (a child that never spoke, a quiet stderr) is removed. */
  close(): void {
    for (const sink of [this.stream, this.stderr]) {
      if (!sink) continue;
      closeSync(sink.fd);
      const path = join(this.dir, sink.name);
      if (statSync(path, { throwIfNoEntry: false })?.size === 0) unlinkSync(path);
    }
    this.stream = undefined;
    this.stderr = undefined;
  }

  private openSink(name: string): Sink {
    return { fd: openSync(join(this.dir, name), 'a'), name };
  }

  private write(sink: Sink | undefined, text: string, failure: string): void {
    if (!sink) return;
    try {
      writeSync(sink.fd, text);
    } catch (err) {
      this.log.error(failure, { err });
    }
  }
}

/** Rename `from` to `to`; when `to` exists, append instead so no captured line is lost. */
function moveOrAppend(from: string, to: string): void {
  if (!existsSync(from)) return;
  if (!existsSync(to)) {
    renameSync(from, to);
    return;
  }
  appendFileSync(to, readFileSync(from));
  unlinkSync(from);
}

/** `YYYY-MM-DD HH:MM:SS`, local time. */
function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
