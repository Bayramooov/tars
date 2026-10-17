import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadDeclaredReminders } from '../../src/scheduler/declared.ts';
import { tempDir } from '../helpers/tmp.ts';

const OWNER = 42;

function file(body: string): string {
  const path = join(tempDir(), 'default-reminders.json');
  writeFileSync(path, body);
  return path;
}

const doc = (...entries: unknown[]) => file(JSON.stringify({ reminders: entries }));
const load = (path: string) => loadDeclaredReminders(path, OWNER);

/** The `ReminderConfigError` message loading `path` fails with. */
function failure(path: string): string {
  try {
    load(path);
  } catch (err) {
    expect((err as Error).name).toBe('ReminderConfigError');
    return (err as Error).message;
  }
  throw new Error('expected a ReminderConfigError');
}

describe('default-reminders.json', () => {
  it('parses every entry, in file order', () => {
    const reminders = load(
      doc(
        { name: 'morning-trends', cron: '0 6 * * *', text: 'Post today\'s trends digest.' },
        { name: 'weekly-review', cron: '0 18 * * 5', chat: 12345, text: 'Summarize the week.' },
      ),
    );
    expect(reminders.map((r) => r.name)).toEqual(['morning-trends', 'weekly-review']);
    expect(reminders[1]).toMatchObject({ cron: '0 18 * * 5', chatId: 12345, enabled: true, text: 'Summarize the week.' });
  });

  it('sends to the owner unless a chat is given', () => {
    expect(load(doc({ name: 'x', cron: '0 6 * * *', text: 'hi' }))[0]?.chatId).toBe(OWNER);
  });

  it('joins a text list with newlines, and may mix both forms in one file', () => {
    const reminders = load(
      doc(
        { name: 'short', cron: '0 6 * * *', text: 'One-line reminder.' },
        { name: 'brief', cron: '0 6 * * *', text: ['Good morning.', '', 'Put together today\'s brief.'] },
      ),
    );
    expect(reminders.map((r) => r.text)).toEqual(['One-line reminder.', 'Good morning.\n\nPut together today\'s brief.']);
  });

  it('is on unless `enabled` is false', () => {
    expect(load(doc({ name: 'x', cron: '0 6 * * *', text: 'hi' }))[0]?.enabled).toBe(true);
    expect(load(doc({ name: 'x', cron: '0 6 * * *', text: 'hi', enabled: false }))[0]?.enabled).toBe(false);
  });

  it('declares nothing when the file is missing', () => {
    expect(load(join(tempDir(), 'nope.json'))).toEqual([]);
    expect(load(file('{}'))).toEqual([]);
  });

  it.each([
    [{ cron: '0 6 * * *', text: 'x' }, "reminders[0]: 'name' is required and must be non-empty"],
    [{ name: '  ', cron: '0 6 * * *', text: 'x' }, "reminders[0]: 'name' is required and must be non-empty"],
    [{ name: 'a', text: 'x' }, "reminders[0]: 'cron' is required and must be non-empty"],
    [{ name: 'a', cron: '0 6 * * *' }, "reminders[0]: 'text' is required and must be a string or a list of strings"],
    [{ name: 'a', cron: '0 6 * * *', text: 123 }, "reminders[0]: 'text' is required and must be a string or a list of strings"],
    [{ name: 'a', cron: '0 6 * * *', text: [] }, "reminders[0]: 'text' must be non-empty"],
    [{ name: 'a', cron: '0 6 * * *', text: ' \n ' }, "reminders[0]: 'text' must be non-empty"],
    [{ name: 'a', cron: '0 6 * * *', text: ['ok', 5] }, "reminders[0]: 'text' list items must be strings"],
    [{ name: 'a', cron: 'not a cron', text: 'x' }, 'reminders[0]: invalid cron expression "not a cron"'],
    [{ name: 'a', cron: '0 6 * * *', text: 'x', chat: 'nope' }, `reminders[0]: 'chat' must be "owner" or a numeric chat id, got "nope"`],
    [{ name: 'a', cron: '0 6 * * *', text: 'x', chat: true }, `reminders[0]: 'chat' must be "owner" or a numeric chat id, got true`],
    [{ name: 'a', cron: '0 6 * * *', text: 'x', chat: null }, `reminders[0]: 'chat' must be "owner" or a numeric chat id, got null`],
    [{ name: 'a', cron: '0 6 * * *', text: 'x', chat: 1.5 }, `reminders[0]: 'chat' must be "owner" or a numeric chat id, got 1.5`],
    [{ name: 'a', cron: '0 6 * * *', text: 'x', enabled: 'yes' }, `reminders[0]: 'enabled' must be true or false, got "yes"`],
    [{ name: 'a', cron: '0 6 * * *', text: 'x', enabled: 1 }, "reminders[0]: 'enabled' must be true or false, got 1"],
  ])('refuses %j', (entry, message) => {
    expect(failure(doc(entry))).toBe(message);
  });

  // fields are checked in order (name, cron, text, cron validity, chat, enabled), entries by index
  it('reports the first problem of the first bad entry', () => {
    expect(failure(doc({ name: 'ok', cron: '0 6 * * *', text: 'x' }, { cron: 'bad', text: 5, chat: 'nope' }))).toBe("reminders[1]: 'name' is required and must be non-empty");
    expect(failure(doc({ name: 'a', cron: 'bad', text: 5 }))).toBe("reminders[0]: 'text' is required and must be a string or a list of strings");
    expect(failure(doc({ name: 'a', cron: 'bad', text: 'x', chat: 'nope' }))).toBe('reminders[0]: invalid cron expression "bad"');
  });

  it('refuses malformed files, naming the file', () => {
    expect(failure(file('this is { not json'))).toMatch(/default-reminders\.json is not valid JSON: /);
    const top = file('[1, 2, 3]');
    expect(failure(top)).toBe(`${top}: top level must be a JSON object`);
    const notList = file(JSON.stringify({ reminders: 'oops' }));
    expect(failure(notList)).toBe(`${notList}: 'reminders' must be a list`);
    const nullList = file(JSON.stringify({ reminders: null }));
    expect(failure(nullList)).toBe(`${nullList}: 'reminders' must be a list`);
    expect(failure(file(JSON.stringify({ reminders: ['oops'] })))).toBe('reminders[0] must be an object');
    const dup = doc({ name: 'dup', cron: '0 6 * * *', text: 'a' }, { name: 'dup', cron: '0 7 * * *', text: 'b' });
    expect(failure(dup)).toBe(`${dup}: duplicate reminder name "dup"`);
  });

  // anything else that goes wrong reading the file stops boot too
  it('does not swallow a file it cannot read', () => {
    const dir = join(tempDir(), 'default-reminders.json');
    mkdirSync(dir);
    expect(() => load(dir)).toThrow(/EISDIR/);
  });
});

describe('committed seed keys', () => {
  const key = (entry: object, owner = OWNER) => loadDeclaredReminders(doc({ name: 'n', cron: '0 6 * * *', text: 'hi', ...entry }), owner)[0]?.key;

  // pinned: keys are stored, so a changed hash would re-seed every declared reminder at the next boot
  it('hashes cron, text and resolved chat into a namespaced key', () => {
    expect(loadDeclaredReminders(doc({ name: 'morning-trends', cron: '0 6 * * *', text: 'Post today\'s trends digest.' }), 42)[0]?.key).toBe('committed:morning-trends:70eb67bd');
    expect(loadDeclaredReminders(doc({ name: 'weekly-review', cron: '0 18 * * 5', text: 'Summarize the week.' }), 42)[0]?.key).toBe('committed:weekly-review:bc16820b');
    expect(loadDeclaredReminders(doc({ name: 'group-digest', cron: '0 9 * * *', text: 'Daily group digest.', chat: -100123 }), 42)[0]?.key).toBe('committed:group-digest:9f03df76');
    expect(loadDeclaredReminders(doc({ name: 'b', cron: '0 6 * * *', text: 'a\nb' }), 42)[0]?.key).toBe('committed:b:597aa4f2');
  });

  it('is the same for the string and list forms of one text, and ignores `enabled`', () => {
    expect(key({ text: 'a\nb' })).toBe(key({ text: ['a', 'b'] }));
    expect(key({ enabled: false })).toBe(key({}));
    expect(key({ chat: 'owner' })).toBe(key({ chat: OWNER }));
  });

  it.each([{ cron: '0 7 * * *' }, { text: 'changed' }, { chat: 999 }])('changes when %j changes', (change) => {
    expect(key(change)).not.toBe(key({}));
  });
});
