import { afterEach, describe, expect, it, vi } from 'vitest';

import { TypingIndicator } from '../../src/engine/typing.ts';
import { memoryLogger } from '../helpers/log.ts';

afterEach(() => vi.useRealTimers());

function setup() {
  vi.useFakeTimers();
  const calls: number[] = [];
  const typing = new TypingIndicator((chatId) => Promise.resolve(void calls.push(chatId)), memoryLogger());
  return { typing, calls };
}

describe('typing indicator', () => {
  it('shows typing at once on arrival and refreshes every 5 s', async () => {
    const { typing, calls } = setup();
    typing.prime(1);
    typing.prime(1);
    expect(calls).toEqual([1]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toEqual([1, 1]);
    typing.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([1, 1]);
  });

  it('fires for every chat of a turn, adding new chats to a running loop', async () => {
    const { typing, calls } = setup();
    await typing.start(new Set([1, 2]));
    expect(calls).toEqual([1, 2]);
    await typing.start(new Set([2, 3]));
    expect(calls).toEqual([1, 2, 3]);
  });

  it('drops a replied chat after it was visible for at least a second, refreshing the rest', async () => {
    const { typing, calls } = setup();
    await typing.start(new Set([1, 2]));
    typing.replied(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([1, 2, 2]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toEqual([1, 2, 2, 2]);
    typing.replied(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toEqual([1, 2, 2, 2]);
  });

  it('drops every chat that replied within the first second', async () => {
    const { typing, calls } = setup();
    await typing.start(new Set([1, 2]));
    typing.replied(1);
    typing.replied(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toEqual([1, 2, 2]);
  });
});
