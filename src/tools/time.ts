import { z } from 'zod';

import { defineTool, type Tool } from '../mcp/tool.ts';

/** `time_now`: the current time in UTC and in the host's zone, ISO-8601 to the second. */
export function timeNowTool(): Tool {
  return defineTool({
    name: 'time_now',
    description: 'Return the current time as ISO8601 in both UTC and the host\'s local timezone. Use to ground \'now\' before computing a date/time. To schedule a future action use reminder_set, not this. Doubles as a basic \'is the tool channel alive\' check.',
    args: z.object({}),
    run: () => {
      const now = new Date();
      const utc = isoSeconds(now, 0);
      const local = isoSeconds(now, -now.getTimezoneOffset());
      return Promise.resolve({ content: `utc=${utc} local=${local}`, data: { utc, local } });
    },
  });
}

/** `YYYY-MM-DDTHH:MM:SS±HH:MM` at a fixed offset (minutes east of UTC). */
function isoSeconds(date: Date, offsetMinutes: number): string {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 19);
  const abs = Math.abs(offsetMinutes);
  const sign = offsetMinutes < 0 ? '-' : '+';
  return `${shifted}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}
