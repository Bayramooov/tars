import { sqliteTime } from '../db/database.ts';

// tars's cron dialect, evaluated in UTC. 5 fields fire on whole minutes; a 6th
// field is seconds (LAST, unlike most Node libraries), a 7th the year; `@daily`
// style nicknames, `15W` and `5#2` work too. Hand-rolled because croner, the
// obvious library, reads 6 fields seconds-first and skips days after a short
// month (`0 9 1,30 * *` from Feb 27 jumps to Mar 30).

const DOM = 2;
const MONTH = 3;
const DOW = 4;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Nicknames, matched against the whole lowercased expression. */
const ALIASES = new Map([
  ['@midnight', '0 0 * * *'],
  ['@hourly', '0 * * * *'],
  ['@daily', '0 0 * * *'],
  ['@weekly', '0 0 * * 0'],
  ['@monthly', '0 0 1 * *'],
  ['@yearly', '0 0 1 1 *'],
  ['@annually', '0 0 1 1 *'],
]);

const RANGE = /^([^-]+)-([^-/]+)(?:\/(\d+))?$/;
/** `5#2` / `mon-fri#2` (nth weekday of the month) or `l5` (last Friday). */
const NTH_WEEKDAY = /^(?:(\w+|[a-z]{3}-[a-z]{3})#(\d+)|l(\d+))$/;

/** A field's position and bounds, and how many fields the expression has. */
interface Field {
  index: number;
  lo: number;
  hi: number;
  count: number;
}

/** A calendar day (UTC). */
interface Day {
  year: number;
  month: number;
  day: number;
  weekday: number;
  monthLength: number;
}

/**
 * A day-of-month or weekday rule. `star` rules don't OR with the other day
 * field; `sticky` ones (`15W`, `5#2`) still apply while the day fields are ORed.
 */
interface DayRule {
  test(day: Day): boolean;
  star: boolean;
  sticky: boolean;
}

const ANY: DayRule = { test: () => true, star: true, sticky: false };

/** A field's values; `star` when anything matches there. */
interface Values {
  found: Set<number>;
  star: boolean;
}

/** `[weekday, n]`: the nth such weekday of the month, `'L'` the last. */
type NthWeekday = [weekday: number, nth: number | 'L'];

interface Schedule {
  /** Seconds between candidate times: whole minutes for 5 fields. */
  tick: number;
  hours: number[];
  minutes: number[];
  seconds: number[];
  months: Values;
  years: Values;
  dom: DayRule;
  dow: DayRule;
}

/** Whether tars can schedule `expr`: it parses and fires at least once after `after`, so a reminder never fires once and stalls. */
export function isValidCron(expr: string, after: Date = new Date()): boolean {
  const schedule = parse(expr);
  return schedule !== undefined && nextTime(schedule, after) !== undefined;
}

/** The first fire strictly after `after`, as the stored UTC timestamp. */
export function nextFire(expr: string, after: Date): string {
  const schedule = parse(expr);
  if (!schedule) throw new Error(`invalid cron expression ${JSON.stringify(expr)}`);
  const next = nextTime(schedule, after);
  if (next === undefined) throw new Error(`failed to find next date for cron expression ${JSON.stringify(expr)}`);
  return sqliteTime(new Date(next * 1000));
}

function parse(expr: string): Schedule | undefined {
  const lowered = expr.toLowerCase();
  const fields = (ALIASES.get(lowered) ?? lowered).split(/\s+/).filter(Boolean);
  if (fields.length < 5 || fields.length > 7) return undefined;
  // Without a seconds field it fires at second 0; without a year field, any year.
  const text = (index: number) => fields[index] ?? (index === 5 ? '0' : '*');
  const field = (index: number, lo: number, hi: number): Field => ({ index, lo, hi, count: fields.length });
  const schedule = {
    tick: fields.length === 5 ? 60 : 1,
    hours: times(text(1), field(1, 0, 23)),
    minutes: times(text(0), field(0, 0, 59)),
    seconds: times(text(5), field(5, 0, 59)),
    months: values(text(MONTH).split(','), field(MONTH, 1, 12)),
    years: values(text(6).split(','), field(6, 1970, 2099)),
    dom: dayOfMonth(text(DOM), field(DOM, 1, 31), text(DOW)),
    dow: dayOfWeek(text(DOW), field(DOW, 0, 6), text(DOM)),
  };
  return Object.values(schedule).includes(undefined) ? undefined : (schedule as Schedule);
}

/**
 * Two restricted day fields are ORed by searching each alone (the other
 * field's sticky rule still applying) and taking the earlier — and fails if
 * either half never fires.
 */
function nextTime(s: Schedule, after: Date): number | undefined {
  const { dom, dow } = s;
  if (dom.star || dow.star) return search(s, after, (day) => dom.test(day) && dow.test(day));
  const byDay = search(s, after, (day) => dom.test(day) && (!dow.sticky || dow.test(day)));
  const byWeekday = search(s, after, (day) => (!dom.sticky || dom.test(day)) && dow.test(day));
  return byDay === undefined || byWeekday === undefined ? undefined : Math.min(byDay, byWeekday);
}

/** The first matching second (epoch) after `after`, walking day by day; gives up 50 years on. */
function search(s: Schedule, after: Date, dayMatches: (day: Day) => boolean): number | undefined {
  const start = (Math.floor(after.getTime() / 1000 / s.tick) + 1) * s.tick;
  const startYear = new Date(start * 1000).getUTCFullYear();
  for (let midnight = Math.floor(start / 86400) * 86400; ; midnight += 86400) {
    const day = calendar(midnight);
    if (day.year - startYear > 50) return undefined;
    const time = inCalendar(s, day) && dayMatches(day) ? firstTime(s, start - midnight) : undefined;
    if (time !== undefined) return midnight + time;
  }
}

const inCalendar = (s: Schedule, day: Day) => (s.years.star || s.years.found.has(day.year)) && (s.months.star || s.months.found.has(day.month));

/** The earliest time of day (seconds) at or after `from`. */
function firstTime({ hours, minutes, seconds }: Schedule, from: number): number | undefined {
  for (const hour of hours) {
    for (const minute of minutes) {
      for (const second of seconds) {
        const time = hour * 3600 + minute * 60 + second;
        if (time >= from) return time;
      }
    }
  }
  return undefined;
}

function calendar(midnight: number): Day {
  const date = new Date(midnight * 1000);
  const [year, month] = [date.getUTCFullYear(), date.getUTCMonth() + 1];
  return { year, month, day: date.getUTCDate(), weekday: date.getUTCDay(), monthLength: new Date(Date.UTC(year, month, 0)).getUTCDate() };
}

/** Days of the month: values and `L` (the last day), or a lone `15W` (the nearest weekday). */
function dayOfMonth(text: string, field: Field, weekdayText: string): DayRule | undefined {
  if (text === '?') return ANY;
  if (text.includes('w')) return nearestWeekday(/^(?:(\d+)w|w(\d+))$/.exec(text));
  const items = text.split(',');
  const last = items.includes('l');
  const days = values(items.filter((item) => item !== 'l'), field);
  if (!days || days.star || wholeField(days.found.size + Number(last), 31, weekdayText)) return days && ANY;
  return { star: false, sticky: false, test: (day) => days.found.has(day.day) || (last && day.day === day.monthLength) };
}

/** `15W`: the weekday nearest the 15th (capped at the month's end), never leaving the month. */
function nearestWeekday(match: RegExpExecArray | null): DayRule | undefined {
  const target = Number(match?.[1] ?? match?.[2]);
  if (!(target >= 1 && target <= 31)) return undefined;
  return {
    star: false,
    sticky: true,
    test: (day) => {
      const nearest = Math.min(target, day.monthLength);
      const weekday = (day.weekday + nearest - day.day + 35) % 7;
      if (weekday === 6) return day.day === (nearest > 1 ? nearest - 1 : nearest + 2);
      if (weekday === 0) return day.day === (nearest < day.monthLength ? nearest + 1 : nearest - 2);
      return day.day === nearest;
    },
  };
}

/** Weekdays: values, or nth (`5#2`) and last (`l5`) weekdays. */
function dayOfWeek(text: string, field: Field, dayText: string): DayRule | undefined {
  if (text === '?') return ANY;
  const items = text.split(',');
  const plain = values(items.filter((item) => !NTH_WEEKDAY.test(item)), field);
  const nth = nthWeekdays(items.filter((item) => NTH_WEEKDAY.test(item)), field);
  if (!plain || !nth) return undefined;
  const listed = new Set([...plain.found, ...nth.map(([weekday]) => weekday)]);
  const size = listed.size + Number(plain.star);
  const star = plain.star || wholeField(size, 7, dayText);
  if (!nth.length) return star ? ANY : { star, sticky: false, test: (day) => listed.has(day.weekday) };
  if (mixesPlainWeekdays(nth, listed, size)) return undefined;
  return { star, sticky: true, test: (day) => nth.some((wanted) => isNthWeekday(day, wanted)) };
}

/** Plain weekdays beside nth ones are ignored, and refused unless they repeat nth days or the field covers the week. */
function mixesPlainWeekdays(nth: NthWeekday[], listed: Set<number>, size: number): boolean {
  const nthDays = new Set(nth.map(([weekday]) => weekday));
  return size !== 7 && [...listed].some((weekday) => !nthDays.has(weekday));
}

function nthWeekdays(items: string[], field: Field): NthWeekday[] | undefined {
  const wanted: NthWeekday[] = [];
  for (const item of items) {
    const found = nthItem(item, field);
    if (!found) return undefined;
    wanted.push(...found);
  }
  return wanted;
}

/** `5#2` (n of 1–5), `mon-fri#2` or `l5`. */
function nthItem(item: string, field: Field): NthWeekday[] | undefined {
  const [, days, n, lastOf] = NTH_WEEKDAY.exec(item) ?? [];
  const weekdays = itemValues(days ?? lastOf ?? '', field);
  if (!weekdays || (n !== undefined && !/^0*[1-5]$/.test(n))) return undefined;
  const nth = n === undefined ? 'L' : Number(n);
  return weekdays.map((weekday) => [weekday, nth]);
}

function isNthWeekday(day: Day, [weekday, nth]: NthWeekday): boolean {
  if (day.weekday !== weekday) return false;
  return nth === 'L' ? day.day + 7 > day.monthLength : Math.ceil(day.day / 7) === nth;
}

/** A day field listing every value reads as `*` (so no OR) — unless the other day field has no `*`. */
const wholeField = (size: number, full: number, otherText: string) => size === full && otherText.includes('*');

/** An hour, minute or second field, ascending. */
function times(text: string, field: Field): number[] | undefined {
  const found = values(text.split(','), field);
  if (found?.star) return steps(field.lo, field.hi, 1);
  return found && [...found.found].sort((a, b) => a - b);
}

/** List items — numbers, names, ranges, steps, `*` — expanded. */
function values(items: string[], field: Field): Values | undefined {
  const found = new Set<number>();
  for (const item of items) {
    const expanded = item === '*' ? [] : itemValues(item, field);
    if (!expanded) return undefined;
    for (const value of expanded) found.add(value);
  }
  return { found, star: items.includes('*') };
}

/** One list item — `5`, `mon`, `1-5`, `fri-mon`, `10/5`, a starred step — with every value inside the field's bounds. */
function itemValues(item: string, field: Field): number[] | undefined {
  const { lo, hi } = field;
  const text = field.index === DOM ? item.replace(/-l(?=\/|$)/, '-31') : item; // a day range may end at `L`
  const range = RANGE.exec(text.replace(/^\*(?=\/.)/, `${lo}-${hi}`)) ?? RANGE.exec(text.replace(/^(.+)\/(.+)$/, `$1-${hi}/$2`));
  const single = toNumber(item, field.index);
  let found: number[] | undefined;
  if (range) found = rangeValues(range, field);
  else if (single !== undefined) found = [alias(single, field)];
  return found?.every((value) => value >= lo && value <= hi) ? found : undefined;
}

/** `a-b/s`: a reversed range wraps past the field's end, `a-a` is the whole cycle, a step may exceed the field. */
function rangeValues(match: RegExpExecArray, field: Field): number[] | undefined {
  const bounds = rangeBounds(match, field);
  if (!bounds) return undefined;
  const [a, b, step] = bounds;
  const { lo, hi } = field;
  if (a < b) return steps(a, b, step);
  if (a === b) return steps(lo, hi, step);
  const head = steps(a, hi, step);
  const last = head.at(-1) ?? a;
  // After wrapping, the step resumes one past where the cycle would land (unless it lands exactly on `lo`).
  return [...head, ...steps(last + step > hi + 1 ? lo + last + step - hi : lo, b, step)];
}

function rangeBounds([, from = '', to = '', every = '1']: RegExpExecArray, field: Field): [number, number, number] | undefined {
  const [low, high, step] = [toNumber(from, field.index), toNumber(to, field.index), Number(every)];
  if (low === undefined || high === undefined || step === 0) return undefined;
  const [a, b] = [alias(low, field), alias(high, field)];
  return Math.max(a, b) > field.hi ? undefined : [a, b, step];
}

function steps(from: number, to: number, step: number): number[] {
  const found: number[] = [];
  for (let value = from; value <= to; value += step) found.push(value);
  return found;
}

/** A number, or a month or weekday name in those fields. */
function toNumber(token: string, index: number): number | undefined {
  if (/^\d+$/.test(token)) return Number(token);
  if (index === MONTH && MONTHS.includes(token)) return MONTHS.indexOf(token) + 1;
  if (index === DOW && WEEKDAYS.includes(token)) return WEEKDAYS.indexOf(token);
  return undefined;
}

/** Weekday 7 is Sunday only in 5-field form, and day 0 is day 1 only in 6-field form. */
function alias(value: number, field: Field): number {
  if (field.index === DOW && field.count === 5 && value === 7) return 0;
  if (field.index === DOM && field.count === 6 && value === 0) return 1;
  return value;
}
