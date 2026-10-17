import { describe, expect, it } from 'vitest';

import type { ToolCallRow } from '../../../src/db/toolcalls.ts';
import { McpHttpServer } from '../../../src/mcp/server.ts';
import { createPollTool, stopPollTool } from '../../../src/tools/telegram/poll.ts';
import { expectGoldenTool } from '../../golden/tools.ts';
import { call, messageRow, toolContext } from './harness.ts';

const POLL = { chat_id: -100, question: 'Lunch?', options: ['Plov', 'Lagman'] };

describe('telegram_create_poll', () => {
  it('matches the tools/list snapshot', () => {
    const { ctx } = toolContext();
    expectGoldenTool(createPollTool(ctx));
    expectGoldenTool(stopPollTool(ctx));
  });

  it('sends a regular poll (no topic), records it with its options, and reports both ids', async () => {
    const t = toolContext();
    const out = await call(createPollTool(t.ctx), POLL);
    expect(t.fake.sent('sendPoll')[0]?.payload).toEqual({
      chat_id: -100,
      question: 'Lunch?',
      options: [{ text: 'Plov' }, { text: 'Lagman' }],
      is_anonymous: true,
      type: 'regular',
      allows_multiple_answers: false,
    });
    expect(out).toEqual({ content: 'poll sent message_id=5001 poll_id=poll5001', data: { message_id: 5001, poll_id: 'poll5001', chat_id: -100 } });
    expect(messageRow(t.db, -100, 5001)).toMatchObject({ direction: 'out', user_id: 999, text: '[poll] Lunch?\n- Plov\n- Lagman', reply_to_id: null });
    expect(t.log.text()).toContain('hot-path stage=delivered chat=-100 msg=5001 poll=poll5001');
    expect(t.log.text()).toContain('[TX] G [-100] m5001 | [poll] Lunch?');
    expect(t.replied).toEqual([-100]);
  });

  it('sends a quiz with its answer, explanation, timer and reply target', async () => {
    const t = toolContext();
    const quiz = { chat_id: 111, question: 'Capital?', options: ['Bukhara', 'Samarkand', 'Tashkent'], type: 'quiz', correct_option_id: 2, explanation: 'Since 1930', open_period: 30, reply_to_message_id: 9 };
    await call(createPollTool(t.ctx), quiz);
    expect(t.fake.sent('sendPoll')[0]?.payload).toMatchObject({ type: 'quiz', correct_option_ids: [2], explanation: 'Since 1930', open_period: 30, reply_parameters: { message_id: 9 } });
    expect(messageRow(t.db, 111, 5001)).toMatchObject({ reply_to_id: 9 });
    expect(t.log.text()).toContain('[TX] DM Ali[111] m5001 →m9 | [poll] Capital?');
  });

  it('checks the cross-field rules in a fixed order before calling Telegram', async () => {
    const t = toolContext();
    const tool = createPollTool(t.ctx);
    const cases: [Record<string, unknown>, string][] = [
      [{ options: ['a', ''] }, 'option 1 must be 1-100 chars'],
      [{ options: ['a', 'x'.repeat(101)] }, 'option 1 must be 1-100 chars'],
      [{ options: ['', 'b'], type: 'quiz' }, 'option 0 must be 1-100 chars'],
      [{ type: 'quiz' }, "correct_option_id is required when type='quiz'"],
      [{ type: 'quiz', correct_option_id: 0, allows_multiple_answers: true }, 'allows_multiple_answers is only valid for regular polls'],
      [{ correct_option_id: 0 }, "correct_option_id is only valid when type='quiz'"],
      [{ explanation: '' }, "explanation is only valid when type='quiz'"],
      [{ type: 'quiz', correct_option_id: 2 }, 'correct_option_id is out of range'],
      [{ open_period: 5, close_date: 1_900_000_000 }, 'open_period and close_date are mutually exclusive'],
    ];
    for (const [extra, rule] of cases) {
      await expect(call(tool, { ...POLL, ...extra })).rejects.toThrow(new Error(rule));
    }
    expect(t.fake.sent('sendPoll')).toEqual([]);
  });

  it('a broken rule reaches the model as a thrown error, audited and logged like any tool failure', async () => {
    const t = toolContext();
    const audit: ToolCallRow[] = [];
    const server = new McpHttpServer({ tools: [createPollTool(t.ctx)], log: t.log, beat: () => {}, audit: (row) => void audit.push(row) });
    const error = "Error: correct_option_id is required when type='quiz'";
    expect(await server.call('telegram_create_poll', { ...POLL, type: 'quiz' })).toEqual({ content: [{ type: 'text', text: error }], isError: true });
    expect(audit[0]?.error).toBe(error);
    expect(t.log.text()).toContain('ERROR tool telegram_create_poll failed');
  });

  it('counts lengths in code points', async () => {
    const t = toolContext();
    const server = new McpHttpServer({ tools: [createPollTool(t.ctx)], log: t.log, beat: () => {}, audit: () => {} });
    const emoji = { ...POLL, question: '👍'.repeat(300), options: ['🔥'.repeat(100), 'b'] };
    expect(await server.call('telegram_create_poll', emoji)).toMatchObject({ isError: false });
    const tooLong = await server.call('telegram_create_poll', { ...POLL, question: 'q'.repeat(301) });
    expect(tooLong).toEqual({ content: [{ type: 'text', text: 'Invalid arguments:\n✖ Too big: expected string to have <=300 characters\n  → at question' }], isError: true });
    await expect(call(createPollTool(t.ctx), { ...POLL, options: ['🔥'.repeat(101), 'b'] })).rejects.toThrow('option 0 must be 1-100 chars');
    expect(await server.call('telegram_create_poll', { ...POLL, options: ['only'] })).toMatchObject({ isError: true });
    expect(t.fake.sent('sendPoll')).toHaveLength(1);
  });
});

describe('telegram_stop_poll', () => {
  it('closes the poll and reports the tallies, persisting nothing', async () => {
    const t = toolContext();
    const options = [{ text: 'Plov', voter_count: 3 }, { text: 'Lagman', voter_count: 1 }];
    t.fake.respond('stopPoll', { id: 'p1', question: 'Lunch?', options, total_voter_count: 4, is_closed: true, is_anonymous: true, type: 'regular', allows_multiple_answers: false });
    const out = await call(stopPollTool(t.ctx), { chat_id: -100, message_id: 5001 });
    expect(t.fake.sent('stopPoll')[0]?.payload).toEqual({ chat_id: -100, message_id: 5001 });
    expect(out).toEqual({
      content: 'poll closed: 4 votes\n- Plov: 3\n- Lagman: 1',
      data: { poll_id: 'p1', total_voter_count: 4, options, is_closed: true, chat_id: -100, message_id: 5001 },
    });
    expect(t.log.text()).toContain('poll closed chat=-100 msg=5001 votes=4');
    expect(t.log.text()).not.toContain('[TX]');
    expect(t.db.prepare('SELECT COUNT(*) FROM messages').pluck().get()).toBe(0);
    expect(t.replied).toEqual([]);
  });

  it('surfaces Telegram refusing to stop it', async () => {
    const t = toolContext();
    t.fake.fail('stopPoll', 400, 'Bad Request: poll has already been closed');
    await expect(call(stopPollTool(t.ctx), { chat_id: -100, message_id: 5001 })).rejects.toMatchObject({
      name: 'GrammyError',
      message: "Call to 'stopPoll' failed! (400: Bad Request: poll has already been closed)",
    });
  });
});
