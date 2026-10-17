import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { WireCapture } from '../../src/claude/capture.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

describe('raw wire capture', () => {
  it('writes pending files, then renames them once the session is known', () => {
    const dir = tempDir();
    const capture = new WireCapture(dir, memoryLogger());
    capture.open(undefined);
    capture.writeStream('{"type":"system","subtype":"init","session_id":"abc"}');
    capture.writeStream('not json at all');
    capture.writeStderr('a warning');
    capture.sessionKnown('abc');
    capture.writeStream('{"type":"result"}');
    capture.close();
    expect(readdirSync(dir).sort()).toEqual(['abc.stderr.log', 'abc.stream.jsonl']);
    expect(readFileSync(join(dir, 'abc.stream.jsonl'), 'utf8')).toBe('{"type":"system","subtype":"init","session_id":"abc"}\nnot json at all\n{"type":"result"}\n');
    expect(readFileSync(join(dir, 'abc.stderr.log'), 'utf8')).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d a warning\n$/);
  });

  it('appends to a known session file across reopens', () => {
    const dir = tempDir();
    const capture = new WireCapture(dir, memoryLogger());
    capture.open('s1');
    capture.writeStream('one');
    capture.close();
    capture.open('s1');
    capture.writeStream('two');
    capture.close();
    expect(readFileSync(join(dir, 's1.stream.jsonl'), 'utf8')).toBe('one\ntwo\n');
  });

  it('leaves no empty files behind: a child that never spoke, or a quiet stderr', () => {
    const dir = tempDir();
    const capture = new WireCapture(dir, memoryLogger());
    capture.open(undefined);
    capture.close();
    expect(readdirSync(dir)).toEqual([]);
    capture.open(undefined);
    capture.writeStream('{"type":"system","subtype":"init","session_id":"s3"}');
    capture.sessionKnown('s3');
    capture.writeStream('{"type":"result"}');
    capture.close();
    expect(readdirSync(dir)).toEqual(['s3.stream.jsonl']);
  });

  // no captured line is dropped when the target exists
  it('appends the pending capture when the session file already exists', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 's2.stream.jsonl'), 'earlier\n');
    const capture = new WireCapture(dir, memoryLogger());
    capture.open(undefined);
    capture.writeStream('init line');
    capture.sessionKnown('s2');
    capture.close();
    expect(readFileSync(join(dir, 's2.stream.jsonl'), 'utf8')).toBe('earlier\ninit line\n');
    expect(readdirSync(dir).some((n) => n.startsWith('pending-'))).toBe(false);
  });

  it('disables itself (with an error log) when the directory is unusable', () => {
    const dir = tempDir();
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    const log = memoryLogger();
    const capture = new WireCapture(file, log);
    capture.open('s');
    capture.writeStream('dropped');
    expect(log.text()).toContain('failed to open cc raw-capture files; capture disabled');
    expect(existsSync(join(file, 's.stream.jsonl'))).toBe(false);
  });
});
