import type { Db } from '../../db/database.ts';

/** The engine readings `/health` shows. */
export interface TurnState {
  /** Seconds the current turn has been running; undefined when idle. */
  readonly turnElapsedSeconds: number | undefined;
  readonly pendingCount: number;
}

/** `/health`: the day-to-day operational readout (legacy Markdown). */
export function healthText(db: Db, engine: TurnState, paused: boolean): string {
  const elapsed = engine.turnElapsedSeconds;
  return [
    '*tars health*',
    `- status: ${paused ? '⏸ PAUSED (dropping messages)' : 'active'}`,
    lastSend(db),
    selfReflection(db),
    notices(db),
    elapsed === undefined ? '- current turn: idle' : `- current turn: running for ${Math.round(elapsed)}s`,
    `- queued messages: ${engine.pendingCount}`,
  ].join('\n');
}

// Each section reports its own query failure (a locked or damaged DB) instead of failing the readout.

function lastSend(db: Db): string {
  try {
    const last = db.prepare("SELECT MAX(timestamp) AS last FROM messages WHERE direction='out'").pluck().get() as string | null;
    return `- last bot send: \`${last || '(none yet)'}\` UTC`;
  } catch (err) {
    return `- last bot send: query error (${(err as Error).message})`;
  }
}

function selfReflection(db: Db): string {
  try {
    const row = db
      .prepare("SELECT status, cron_expr, trigger_at FROM reminders WHERE auto_seed_key = 'self-reflection-default' ORDER BY id DESC LIMIT 1")
      .get() as { status: string; cron_expr: string | null; trigger_at: string } | undefined;
    if (!row) return '- self-reflection reminder: MISSING (will re-seed on restart)';
    return `- self-reflection reminder: ${row.status} (cron \`${row.cron_expr ?? 'none'}\`, next \`${row.trigger_at}\` UTC)`;
  } catch (err) {
    return `- self-reflection reminder: query error (${(err as Error).message})`;
  }
}

function notices(db: Db): string {
  try {
    const count = db.prepare('SELECT COUNT(*) AS c FROM rate_limits WHERE notice_sent = 1').pluck().get() as number;
    return `- rate-limit notices fired (lifetime): ${count}`;
  } catch (err) {
    return `- rate-limit notices: query error (${(err as Error).message})`;
  }
}
