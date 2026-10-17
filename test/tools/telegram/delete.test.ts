import { describe, expect, it } from 'vitest';

import { deleteMessageTool } from '../../../src/tools/telegram/delete.ts';
import { expectGoldenTool } from '../../golden/tools.ts';
import { call, messageRow, seedMessage, toolContext } from './harness.ts';

describe('telegram_delete_message', () => {
  it('matches the tools/list snapshot', () => {
    expectGoldenTool(deleteMessageTool(toolContext().ctx));
  });

  it('deletes, logs [DEL], keeps the row flagged deleted, and returns no data', async () => {
    const t = toolContext();
    seedMessage(t.db, -100, 7);
    const out = await call(deleteMessageTool(t.ctx), { chat_id: -100, message_id: 7 });
    expect(t.fake.sent('deleteMessage')[0]?.payload).toEqual({ chat_id: -100, message_id: 7 });
    expect(out).toEqual({ content: 'deleted message_id=7' });
    expect(messageRow(t.db, -100, 7)).toMatchObject({ deleted: 1 });
    expect(t.log.text()).toContain('[DEL] G [-100] m7');
    expect(t.replied).toEqual([]);
  });

  it('surfaces a Telegram failure and leaves the row alone', async () => {
    const t = toolContext();
    seedMessage(t.db, 111, 7);
    t.fake.fail('deleteMessage', 400, "Bad Request: message can't be deleted");
    await expect(call(deleteMessageTool(t.ctx), { chat_id: 111, message_id: 7 })).rejects.toMatchObject({
      name: 'GrammyError',
      message: "Call to 'deleteMessage' failed! (400: Bad Request: message can't be deleted)",
    });
    expect(messageRow(t.db, 111, 7)).toMatchObject({ deleted: 0 });
  });
});
