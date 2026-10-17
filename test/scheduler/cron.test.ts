import { describe, expect, it } from 'vitest';

import { isValidCron, nextFire } from '../../src/scheduler/cron.ts';

const A = new Date('2026-10-17T05:59:59.500Z'); // a Saturday
const B = new Date('2027-02-27T09:00:01Z'); // a Saturday near the end of a short month

/**
 * `[expression, [next after A, next after B]]`: `null` where there is no next
 * fire, `false` where the expression is refused.
 */
const VECTORS: [string, (string | null)[] | false][] = [
  // everyday schedules
  ['0 6 * * *', ['2026-10-17 06:00:00', '2027-02-28 06:00:00']],
  ['0 18 * * 5', ['2026-10-23 18:00:00', '2027-03-05 18:00:00']],
  ['0 9 * * 1-5', ['2026-10-19 09:00:00', '2027-03-01 09:00:00']],
  ['0 0 * * *', ['2026-10-18 00:00:00', '2027-02-28 00:00:00']],
  ['0 9 * * *', ['2026-10-17 09:00:00', '2027-02-28 09:00:00']],
  ['0 7 * * *', ['2026-10-17 07:00:00', '2027-02-28 07:00:00']],
  // names, lists, ranges, steps
  ['0 9 * * MON-FRI', ['2026-10-19 09:00:00', '2027-03-01 09:00:00']],
  ['30 8 * jan,jul *', ['2027-01-01 08:30:00', '2027-07-01 08:30:00']],
  ['*/15 9-17 * * *', ['2026-10-17 09:00:00', '2027-02-27 09:15:00']],
  ['5/20 * * * *', ['2026-10-17 06:05:00', '2027-02-27 09:05:00']],
  ['0 9 1,15 * *', ['2026-11-01 09:00:00', '2027-03-01 09:00:00']],
  ['0 9 1,30 * *', ['2026-10-30 09:00:00', '2027-03-01 09:00:00']],
  // specials: L, W, #, ?, Sunday as 7, nicknames, outer whitespace
  ['0 9 L * *', ['2026-10-31 09:00:00', '2027-02-28 09:00:00']],
  ['0 9 15-L * *', ['2026-10-17 09:00:00', '2027-02-28 09:00:00']],
  ['0 9 15W * *', ['2026-11-16 09:00:00', '2027-03-15 09:00:00']],
  ['0 9 W1 * *', ['2026-11-02 09:00:00', '2027-03-01 09:00:00']],
  ['0 9 * * 5#2', ['2026-11-13 09:00:00', '2027-03-12 09:00:00']],
  ['0 9 * * L5', ['2026-10-30 09:00:00', '2027-03-26 09:00:00']],
  ['0 9 * * mon-fri#1', ['2026-11-02 09:00:00', '2027-03-01 09:00:00']],
  ['0 9 ? * 1', ['2026-10-19 09:00:00', '2027-03-01 09:00:00']],
  ['0 9 * * 7', ['2026-10-18 09:00:00', '2027-02-28 09:00:00']],
  ['@daily', ['2026-10-18 00:00:00', '2027-02-28 00:00:00']],
  ['@WEEKLY', ['2026-10-18 00:00:00', '2027-02-28 00:00:00']],
  ['  0 6 * * *  ', ['2026-10-17 06:00:00', '2027-02-28 06:00:00']],
  // 6 fields = seconds LAST, 7 = seconds then year
  ['0 6 * * * 30', ['2026-10-17 06:00:30', '2027-02-28 06:00:30']],
  ['30 0 6 * * *', ['2026-11-06 00:30:00', '2027-03-06 00:30:00']],
  ['0 6 * * * 30 2030', ['2030-01-01 06:00:30', '2030-01-01 06:00:30']],
  // reversed ranges wrap, `a-a` is the whole cycle, a step may exceed the field
  ['0 22-2 * * *', ['2026-10-17 22:00:00', '2027-02-27 22:00:00']],
  ['0 9 * * fri-mon', ['2026-10-17 09:00:00', '2027-02-28 09:00:00']],
  ['0 9 * dec-feb *', ['2026-12-01 09:00:00', '2027-02-28 09:00:00']],
  ['0 9 * * 1-1', ['2026-10-17 09:00:00', '2027-02-28 09:00:00']],
  ['*/90 * * * *', ['2026-10-17 06:00:00', '2027-02-27 10:00:00']],
  ['0 22-2/3 * * *', ['2026-10-17 22:00:00', '2027-02-27 22:00:00']],
  // day of month OR weekday
  ['0 9 1 * 3', ['2026-10-21 09:00:00', '2027-03-01 09:00:00']],
  ['0 9 13 * 5', ['2026-10-23 09:00:00', '2027-03-05 09:00:00']],
  // valid, but no next fire (never, or more than 50 years on)
  ['0 6 31 2 *', [null, null]],
  ['0 6 31 2 1', [null, null]],
  ['0 6 1 * 5#2', [null, null]],
  ['0 0 1 1 * 0 2077', [null, '2077-01-01 00:00:00']],
  // refused
  ['not a cron', false],
  ['', false],
  ['@reboot', false],
  [' @daily', false],
  ['60 * * * *', false],
  ['0 24 * * *', false],
  ['0 0 32 * *', false],
  ['0 0 * 13 *', false],
  ['0 0 * * 8', false],
  ['? 9 * * *', false],
  ['0 9 * * 5L', false],
  ['0 9 LW * *', false],
  ['0 9 * * +1', false],
  ['/15 * * * *', false],
  ['*/0 * * * *', false],
  ['0 9 * * 1,5#2', false],
  ['0 9 15W,16 * *', false],
  ['0 9 * * 5#6', false],
  ['* * * * * * * *', false],
  ['0 6 * * * 0 2100', false],
  ['0 9 * * 7 0', false],
];

describe('cron (UTC)', () => {
  it.each(VECTORS)('%j', (expr, expected) => {
    expect(isValidCron(expr)).toBe(expected !== false);
    if (expected === false) return;
    const next = [A, B].map((after) => {
      try {
        return nextFire(expr, after);
      } catch {
        return null;
      }
    });
    expect(next).toEqual(expected);
  });

  it('fires strictly after `after`, on the next slot when `after` is exactly on one', () => {
    expect(nextFire('0 6 * * *', new Date('2026-10-17T06:00:00Z'))).toBe('2026-10-18 06:00:00');
    expect(nextFire('0 6 * * *', new Date('2026-10-17T05:59:59.999Z'))).toBe('2026-10-17 06:00:00');
    expect(nextFire('* * * * * */10', new Date('2026-10-17T06:00:30.250Z'))).toBe('2026-10-17 06:00:40');
  });

  it('says why there is no next fire', () => {
    expect(() => nextFire('0 6 31 2 *', A)).toThrow('failed to find next date for cron expression "0 6 31 2 *"');
    expect(() => nextFire('not a cron', A)).toThrow('invalid cron expression "not a cron"');
  });

  // Deliberate: a random `R` field, as some cron dialects have, would make the schedule unpredictable.
  it('refuses a random R field', () => {
    expect(isValidCron('R 9 * * *')).toBe(false);
  });
});
