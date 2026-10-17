import { describe, expect, it } from 'vitest';

import { Transcript } from '../../src/log/transcript.ts';
import { memoryLogger } from '../helpers/log.ts';

function setup(mode: 'compact' | 'full' = 'compact') {
  const log = memoryLogger();
  return { log, tx: new Transcript(log, mode), lines: () => log.records.map((r) => `${r.name} ${r.msg}`) };
}

describe('transcript lines', () => {
  it('labels chats and users, cuts bodies at 200 characters', () => {
    const t = setup();
    t.tx.inbound({ chatId: 5, title: 'Ali', chatType: 'private' }, { id: 5, name: 'Ali' }, { messageId: 3, text: 'line1\nline2', replyToId: 2 }, true);
    t.tx.inbound({ chatId: -100 }, { id: 7 }, { messageId: 4, text: 'x'.repeat(205) }, false);
    t.tx.outbound({ chatId: -100, title: 'Dev' }, { messageId: 9, text: 'ok' });
    expect(t.lines()).toEqual([
      'tars.tx [RX] DM Ali[5] Ali[5] m3 →m2 | line1 line2',
      `tars.tx [DROP] G [-100] [7] m4 (chat not allowed) | ${'x'.repeat(200)}…`,
      'tars.tx [TX] G "Dev"[-100] m9 | ok',
    ]);
  });

  it('logs inbound edits with the chat label and an empty user label for an author-less edit', () => {
    const t = setup();
    t.tx.inboundEdit({ chatId: -100, title: 'Dev' }, { id: 7, name: 'Ali' }, { messageId: 3, text: 'fixed' });
    t.tx.inboundEdit({ chatId: 5 }, {}, { messageId: 4, text: '' });
    expect(t.lines()).toEqual(['tars.tx [RX↺] G "Dev"[-100] Ali[7] m3 (edited) | fixed', 'tars.tx [RX↺] DM [5]  m4 (edited) | ']);
  });

  it('logs edits, deletes and reactions', () => {
    const t = setup();
    t.tx.edit({ chatId: 1 }, 2, 'new');
    t.tx.delete({ chatId: 1 }, 2);
    t.tx.reaction({ chatId: 1 }, 2, '👍');
    expect(t.lines()).toEqual(['tars.tx [EDIT] DM [1] m2 | new', 'tars.tx [DEL] DM [1] m2', 'tars.tx [REACT] DM [1] m2 👍']);
  });

  it('renders [CC.*] compactly or in full', () => {
    const compact = setup();
    compact.tx.ccToolUse('mcp__tars__time_now', 'toolu_0123456789', { a: 'Ў' });
    compact.tx.ccToolResult('toolu_0123456789', 'a\nb', false);
    compact.tx.ccDone(undefined, undefined);
    expect(compact.lines()).toEqual(['tars.cc [CC.tool→] mcp__tars__time_now({"a":"Ў"}) id=toolu_01', 'tars.cc [CC.tool✓] id=toolu_01 | a b', 'tars.cc [CC.done] action=none reason=']);
    const full = setup('full');
    full.tx.ccToolResult('toolu_x', Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n'), true);
    expect(full.lines()[0]).toBe(`tars.cc [CC.tool✗] id=toolu_x | ${Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')}\n(+2 more lines)`);
  });
});
