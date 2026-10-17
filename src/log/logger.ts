/** Level names, as the console, the JSON log file and `/logs` show them. */
export const LEVELS = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 } as const;
export type Level = keyof typeof LEVELS;

export interface LogRecord {
  time: Date;
  level: Level;
  /** Dotted logger name, e.g. `tars.engine`. */
  name: string;
  msg: string;
  event?: string | undefined;
  data?: unknown;
  err?: unknown;
}

export type LogSink = (record: LogRecord) => void;

export interface LogExtra {
  event?: string;
  data?: unknown;
  err?: unknown;
}

export interface Logger {
  readonly name: string;
  debug(msg: string, extra?: LogExtra): void;
  info(msg: string, extra?: LogExtra): void;
  warn(msg: string, extra?: LogExtra): void;
  error(msg: string, extra?: LogExtra): void;
  critical(msg: string, extra?: LogExtra): void;
  /** Logger for a sub-component: `tars` → `tars.engine`. */
  child(suffix: string): Logger;
}

/**
 * Root logger fanning records out to `sinks`. Records below `minLevel` are
 * dropped before any sink sees them; a throwing sink never breaks the caller.
 */
export function createLogger(sinks: readonly LogSink[], minLevel: Level = 'INFO', name = 'tars'): Logger {
  const emit = (level: Level, msg: string, extra: LogExtra = {}) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const record: LogRecord = { time: new Date(), level, name, msg, ...extra };
    for (const sink of sinks) {
      try {
        sink(record);
      } catch {
        // A broken sink (closed file, failed DM) must never take the caller down.
      }
    }
  };
  return {
    name,
    debug: (msg, extra) => emit('DEBUG', msg, extra),
    info: (msg, extra) => emit('INFO', msg, extra),
    warn: (msg, extra) => emit('WARNING', msg, extra),
    error: (msg, extra) => emit('ERROR', msg, extra),
    critical: (msg, extra) => emit('CRITICAL', msg, extra),
    child: (suffix) => createLogger(sinks, minLevel, `${name}.${suffix}`),
  };
}
