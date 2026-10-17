import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createApp } from './app.ts';
import { loadConfig, PROJECT_ROOT } from './config.ts';
import { setupLogging } from './log/setup.ts';

// `.env` fills in what the environment doesn't already set (Docker passes it via env_file).
const envFile = join(PROJECT_ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const config = loadConfig(process.env);
const logging = setupLogging(config);
const log = logging.log;

let exiting = false;
async function shutdown(code: number): Promise<void> {
  if (exiting) return;
  exiting = true;
  // Docker allows 15 s after SIGTERM; never hang past it.
  setTimeout(() => process.exit(code), 12_000).unref();
  await app.stop().catch((err: unknown) => log.error('shutdown failed', { err }));
  logging.close();
  process.exit(code);
}

const app = createApp(config, {
  log,
  env: process.env,
  onFatal: () => void shutdown(1),
  // Signal ourselves so /kill takes the same clean shutdown: the handler below logs and exits 0.
  onKill: () => process.kill(process.pid, 'SIGTERM'),
  addLogSink: (sink) => logging.addSink(sink),
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info('signal received, shutting down');
    void shutdown(0);
  });
}
process.on('unhandledRejection', (err) => {
  log.critical('unhandled promise rejection', { err });
  app.killNow();
  void shutdown(1);
});
process.on('uncaughtException', (err) => {
  log.critical('uncaught exception', { err });
  app.killNow();
  void shutdown(1);
});

try {
  await app.start();
} catch (err) {
  log.critical('tars failed to start', { err });
  await shutdown(1);
}
