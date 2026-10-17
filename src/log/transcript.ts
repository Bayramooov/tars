import { clip } from '../text/clip.ts';
import type { Logger } from './logger.ts';

/** Bodies longer than this are cut in one-line (`compact`) rendering. */
const MAX_BODY = 200;
/** In `full` mode a tool result shows this many lines before `(+N more lines)`. */
const PREVIEW_LINES = 10;

export interface ChatLabel {
  chatId: number;
  title?: string | undefined;
  chatType?: string | undefined;
}

/**
 * Greppable one-line conversation log: `[RX]`/`[TX]`/`[DROP]`/`[EDIT]`/`[DEL]`
 * /`[REACT]` on `tars.tx`, and what the model is doing (`[CC.*]`) on
 * `tars.cc`, rendered `compact` (one cut line) or `full`.
 */
export class Transcript {
  private readonly tx: Logger;
  private readonly cc: Logger;
  private readonly full: boolean;

  constructor(root: Logger, mode: 'compact' | 'full') {
    this.tx = root.child('tx');
    this.cc = root.child('cc');
    this.full = mode === 'full';
  }

  inbound(chat: ChatLabel, user: { id: number; name?: string | undefined }, msg: MessageLine, allowed: boolean): void {
    const reply = msg.replyToId ? ` →m${msg.replyToId}` : '';
    const suffix = allowed ? '' : ' (chat not allowed)';
    this.tx.info(`${allowed ? '[RX]' : '[DROP]'} ${chatLabel(chat)} ${userLabel(user)} m${msg.messageId}${reply}${suffix} | ${truncate(msg.text)}`);
  }

  inboundEdit(chat: ChatLabel, user: { id?: number | undefined; name?: string | undefined }, msg: MessageLine): void {
    this.tx.info(`[RX↺] ${chatLabel(chat)} ${userLabel(user)} m${msg.messageId} (edited) | ${truncate(msg.text)}`);
  }

  outbound(chat: ChatLabel, msg: MessageLine): void {
    const mid = msg.messageId ? ` m${msg.messageId}` : '';
    const reply = msg.replyToId ? ` →m${msg.replyToId}` : '';
    this.tx.info(`[TX] ${chatLabel(chat)}${mid}${reply} | ${truncate(msg.text)}`);
  }

  edit(chat: ChatLabel, messageId: number, text: string): void {
    this.tx.info(`[EDIT] ${chatLabel(chat)} m${messageId} | ${truncate(text)}`);
  }

  delete(chat: ChatLabel, messageId: number): void {
    this.tx.info(`[DEL] ${chatLabel(chat)} m${messageId}`);
  }

  reaction(chat: ChatLabel, messageId: number, emoji: string): void {
    this.tx.info(`[REACT] ${chatLabel(chat)} m${messageId} ${emoji}`);
  }

  ccUser(text: string): void {
    this.cc.info(`[CC.user] ${this.render(text)}`);
  }

  ccText(text: string): void {
    this.cc.info(`[CC.text] ${this.render(text)}`);
  }

  ccToolUse(name: string, id: string, args: unknown): void {
    const shown = args && (typeof args !== 'object' || Object.keys(args).length) ? this.render(JSON.stringify(args)) : '';
    this.cc.info(`[CC.tool→] ${name}(${shown}) id=${id.slice(0, 8)}`);
  }

  ccToolResult(id: string, content: string, isError: boolean): void {
    this.cc.info(`${isError ? '[CC.tool✗]' : '[CC.tool✓]'} id=${id.slice(0, 8)} | ${this.preview(content)}`);
  }

  ccDone(action: string | undefined, reason: string | undefined): void {
    this.cc.info(`[CC.done] action=${action ?? 'none'} reason=${truncate(reason)}`);
  }

  private render(text: string): string {
    return this.full ? text : truncate(text);
  }

  private preview(text: string): string {
    if (!this.full) return truncate(text);
    const lines = text.split(/\r\n|\r|\n/);
    if (lines.length <= PREVIEW_LINES) return text;
    return `${lines.slice(0, PREVIEW_LINES).join('\n')}\n(+${lines.length - PREVIEW_LINES} more lines)`;
  }
}

export interface MessageLine {
  messageId: number;
  text: string;
  replyToId?: number | undefined;
}

/** One line, cut at 200 characters. */
function truncate(text: string | undefined): string {
  return clip((text ?? '').replace(/\r\n|\n|\r/g, ' '), MAX_BODY);
}

function chatLabel({ chatId, title, chatType }: ChatLabel): string {
  if (chatType === 'private' || chatId > 0) return title ? `DM ${title}[${chatId}]` : `DM [${chatId}]`;
  return title ? `G "${title}"[${chatId}]` : `G [${chatId}]`;
}

function userLabel({ id, name }: { id?: number | undefined; name?: string | undefined }): string {
  if (id === undefined) return '';
  return name ? `${name}[${id}]` : `[${id}]`;
}
