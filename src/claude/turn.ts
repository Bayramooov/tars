import type { Logger } from '../log/logger.ts';
import type { Transcript } from '../log/transcript.ts';
import { asText } from '../text/json.ts';

export type ControlActionName = 'stop' | 'skip' | 'heartbeat';

/** The turn-end `StructuredOutput`: what to do next, and why. */
export interface ControlAction {
  action: ControlActionName;
  reason?: string | undefined;
}

/** Why a turn was cut short by tars itself rather than ended by the model. */
export type AbortReason = 'tool-error-limit' | 'liveness-wedge' | 'session-reset' | 'crash';

/** One finished (or aborted) turn, handed from the worker to the engine. */
export interface TurnResult {
  textBlocks: string[];
  control?: ControlAction | undefined;
  /** Claude Code stderr lines seen during this turn (last 10). */
  stderrTail: string[];
  /** A delivered message, reaction, edit, delete or poll close — the user perceived a response. */
  userVisibleAction: boolean;
  /** Text was produced but nothing user-visible happened: the reply never reached anyone. */
  droppedText: boolean;
  abortedReason?: AbortReason | undefined;
  /** Error text when the result event reported `is_error` (the API rejected the turn). */
  apiError?: string | undefined;
}

/** Tools whose effect the user can perceive; text without any of them was "dropped". */
export const USER_VISIBLE_TOOLS: ReadonlySet<string> = new Set(
  [
    'telegram_send_message',
    'telegram_reply_to_message',
    'telegram_send_photo',
    'telegram_send_memory_document',
    'telegram_create_poll',
    'telegram_add_reaction',
    'telegram_edit_message',
    'telegram_delete_message',
    'telegram_stop_poll',
  ].map((name) => `mcp__tars__${name}`),
);

const ACTIONS: readonly string[] = ['stop', 'skip', 'heartbeat'];

/** Validate a control action payload; `reason` is required (non-blank) on stop/skip. */
export function parseControlAction(input: unknown): ControlAction | undefined {
  if (!isRecord(input) || !ACTIONS.includes(input.action as string)) return undefined;
  const action = input.action as ControlActionName;
  const reason = input.reason ?? undefined;
  if (reason !== undefined && typeof reason !== 'string') return undefined;
  if (action !== 'heartbeat' && !(reason ?? '').trim()) return undefined;
  return { action, reason };
}

/** Accumulates one turn's stream-json events into a `TurnResult`. */
export class Turn {
  readonly textBlocks: string[] = [];
  readonly stderr: string[] = [];
  private control: ControlAction | undefined;
  private userVisible = false;
  private readonly log: Logger;
  private readonly transcript: Transcript;

  constructor(log: Logger, transcript: Transcript) {
    this.log = log;
    this.transcript = transcript;
  }

  /** Text, tool_use and thinking blocks of one assistant message. */
  addAssistant(event: Record<string, unknown>): void {
    for (const block of contentBlocks(event)) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        this.textBlocks.push(block.text);
        this.transcript.ccText(block.text);
      } else if (block.type === 'tool_use') {
        this.addToolUse(block);
      } else if (block.type === 'thinking') {
        this.transcript.ccText(`(thinking) ${asText(block.thinking ?? '')}`);
      }
    }
  }

  /** The `is_error` flag of every tool_result in a user event, in order. */
  toolResults(event: Record<string, unknown>): boolean[] {
    return contentBlocks(event)
      .filter((block) => block.type === 'tool_result')
      .map((block) => {
        const isError = Boolean(block.is_error);
        this.transcript.ccToolResult(asText(block.tool_use_id ?? ''), flatten(block.content), isError);
        return isError;
      });
  }

  /** Close the turn on its `result` event. */
  finish(event: Record<string, unknown>): TurnResult {
    const apiError = !event.is_error ? undefined : typeof event.result === 'string' && event.result ? event.result : 'unknown API error';
    this.applyResultPayload(event);
    const result: TurnResult = {
      textBlocks: this.textBlocks,
      control: this.control,
      stderrTail: this.stderr.slice(-10),
      userVisibleAction: this.userVisible,
      droppedText: this.textBlocks.length > 0 && !this.userVisible,
      apiError,
    };
    this.transcript.ccDone(this.control?.action, this.control?.reason);
    return result;
  }

  /** A sentinel for a turn tars cut short; carries any text already written. */
  abort(reason: AbortReason): TurnResult {
    return { textBlocks: [...this.textBlocks], stderrTail: this.stderr.slice(-10), userVisibleAction: false, droppedText: false, abortedReason: reason };
  }

  private addToolUse(block: Record<string, unknown>): void {
    const name = typeof block.name === 'string' ? block.name : '?';
    this.transcript.ccToolUse(name, asText(block.id ?? ''), block.input);
    if (USER_VISIBLE_TOOLS.has(name)) this.userVisible = true;
    if (name !== 'StructuredOutput' || !isRecord(block.input)) return;
    const control = parseControlAction(block.input);
    if (control) this.control = control;
    else this.log.warn(`could not parse StructuredOutput input: ${JSON.stringify(block.input)}`);
  }

  /**
   * Older CLIs put the control JSON in `result`/`output` or in the last text
   * block; a valid payload there wins, and a consumed text block is dropped
   * so it isn't mistaken for undelivered prose.
   */
  private applyResultPayload(event: Record<string, unknown>): void {
    let payload: unknown = event.result || event.output;
    const fromText = !payload && this.textBlocks.length > 0;
    if (fromText) payload = this.textBlocks[this.textBlocks.length - 1];
    if (typeof payload === 'string') payload = parseJson(payload);
    if (!isRecord(payload)) return;
    const control = parseControlAction(payload);
    if (!control) {
      this.log.warn(`could not parse control action from ${JSON.stringify(payload)}`);
      return;
    }
    this.control = control;
    if (fromText) this.textBlocks.pop();
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function contentBlocks(event: Record<string, unknown>): Record<string, unknown>[] {
  const content = isRecord(event.message) ? event.message.content : undefined;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

/** A tool_result's content as one string: text parts joined by spaces. */
function flatten(content: unknown): string {
  if (Array.isArray(content)) return content.map((part) => asText(isRecord(part) ? (part.text ?? '') : part)).join(' ');
  return content === undefined || content === null ? '' : asText(content);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
