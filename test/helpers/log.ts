import { createLogger, type Level, type Logger, type LogRecord, type LogSink } from '../../src/log/logger.ts';

/** A logger that records into an array, for asserting on log output; `addSink` mirrors the app's. */
export function memoryLogger(minLevel: Level = 'DEBUG'): Logger & { records: LogRecord[]; text(): string; addSink(sink: LogSink): void } {
  const records: LogRecord[] = [];
  const sinks: LogSink[] = [(r) => records.push(r)];
  const logger = createLogger(sinks, minLevel);
  return Object.assign(logger, { records, text: () => records.map((r) => `${r.level} ${r.msg}`).join('\n'), addSink: (sink: LogSink) => void sinks.push(sink) });
}
