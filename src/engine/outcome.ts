import { classifyFailure, type FailureClass } from '../claude/failures.ts';
import type { TurnResult } from '../claude/turn.ts';

/** Consecutive `heartbeat` continuations allowed in one logical turn. */
export const MAX_HEARTBEATS = 10;

/** Sent after a heartbeat when nothing new arrived, so the model resumes its own task. */
export const HEARTBEAT_NUDGE = '<system>Continue the task you just reported on. Return action "stop" only once it is actually done.</system>';

/** Sent once when a turn that owed a reply ended `stop` with nothing delivered. */
export const SILENT_STOP_NUDGE =
  '<system>You returned action "stop" but sent nothing — no telegram_send_message or telegram_reply_to_message call. ' +
  'The reason field is internal and never shown to the user. If the user is owed a reply, send it now via ' +
  'telegram_send_message or telegram_reply_to_message. If staying silent was intentional (e.g. the user asked for no reply), ' +
  'return action "skip" instead.</system>';

/** What the turn controller knows about the logical turn a result belongs to. */
export interface TurnFacts {
  heartbeats: number;
  silentStopRetried: boolean;
  /** The turn consumed at least one human message (reminders don't count). */
  awaitingReply: boolean;
}

/** Endings tars itself caused or the API imposed. */
export type AbnormalOutcome =
  | { kind: 'session-reset' }
  | { kind: 'crashed' }
  | { kind: 'aborted'; reason: string }
  | { kind: 'api-classified'; failure: FailureClass }
  | { kind: 'api-reset' };

/** Endings the model chose. */
export type NormalOutcome =
  | { kind: 'dropped-text'; failure: FailureClass | undefined }
  | { kind: 'heartbeat' }
  | { kind: 'silent-stop-retry' }
  | { kind: 'finish' };

/** tars's own aborts first (owner reset, crash, breaker/watchdog), then an API rejection. */
export function abnormalOutcome(result: TurnResult): AbnormalOutcome | undefined {
  if (result.abortedReason === 'session-reset') return { kind: 'session-reset' };
  if (result.abortedReason === 'crash') return { kind: 'crashed' };
  if (result.abortedReason) return { kind: 'aborted', reason: result.abortedReason };
  if (!result.apiError) return undefined;
  const failure = classifyFailure([result.apiError, ...result.textBlocks]);
  return failure ? { kind: 'api-classified', failure } : { kind: 'api-reset' };
}

/**
 * Text the model wrote but never sent is rescued unless it chose `skip`;
 * then heartbeat continuation, the one-shot silent-stop retry, or a clean finish.
 */
export function normalOutcome(result: TurnResult, turn: TurnFacts): NormalOutcome {
  const action = result.control?.action;
  if (result.droppedText && action !== 'skip') return { kind: 'dropped-text', failure: classifyFailure(result.textBlocks) };
  if (action === 'heartbeat' && turn.heartbeats < MAX_HEARTBEATS) return { kind: 'heartbeat' };
  if (isSilentStop(result, turn)) return { kind: 'silent-stop-retry' };
  return { kind: 'finish' };
}

/** `stop` promises a reply was sent; an empty one while someone waits is almost always premature. */
function isSilentStop(result: TurnResult, turn: TurnFacts): boolean {
  const deliveredNothing = !result.droppedText && !result.textBlocks.length && !result.userVisibleAction;
  return result.control?.action === 'stop' && deliveredNothing && !turn.silentStopRetried && turn.awaitingReply;
}
