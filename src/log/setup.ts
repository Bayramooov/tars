import { join } from 'node:path';

import type { Config } from '../config.ts';
import { openDailyFile } from './daily.ts';
import { createLogger, type Logger, type LogSink } from './logger.ts';
import { consoleSink, fileSink } from './sinks.ts';

export interface Logging {
  log: Logger;
  /** Add a sink later in boot (the owner notifier needs the bot first). */
  addSink(sink: LogSink): void;
  close(): void;
}

/** Root logger: readable console lines plus `data/logs/tars.log` as JSON, rotated daily, 7 kept. */
export function setupLogging(config: Pick<Config, 'logDir' | 'logLevel'>): Logging {
  const file = openDailyFile(join(config.logDir, 'tars.log'));
  const sinks: LogSink[] = [consoleSink, fileSink(file)];
  return { log: createLogger(sinks, config.logLevel), addSink: (sink) => void sinks.push(sink), close: () => file.close() };
}
