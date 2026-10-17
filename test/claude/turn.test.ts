import { describe, expect, it } from 'vitest';

import { relayError, failedMcpServers, userLine } from '../../src/claude/events.ts';
import { parseControlAction, Turn, USER_VISIBLE_TOOLS } from '../../src/claude/turn.ts';
import { Transcript } from '../../src/log/transcript.ts';
import { memoryLogger } from '../helpers/log.ts';

function turn() {
  const log = memoryLogger();
  return { log, turn: new Turn(log, new Transcript(log, 'compact')) };
}
const assistant = (...content: object[]) => ({ type: 'assistant', message: { content } });
const toolUse = (name: string, input: unknown = {}) => ({ type: 'tool_use', id: 'toolu_abcdefghij', name, input });

describe('control action', () => {
  it('requires a non-blank reason only on stop and skip', () => {
    expect(parseControlAction({ action: 'stop', reason: 'done' })).toEqual({ action: 'stop', reason: 'done' });
    expect(parseControlAction({ action: 'heartbeat' })).toEqual({ action: 'heartbeat', reason: undefined });
    expect(parseControlAction({ action: 'stop' })).toBeUndefined();
    expect(parseControlAction({ action: 'skip', reason: '   ' })).toBeUndefined();
    expect(parseControlAction({ action: 'sleep', reason: 'x' })).toBeUndefined();
    expect(parseControlAction({ action: 'stop', reason: 5 })).toBeUndefined();
    expect(parseControlAction({ action: 'stop', reason: 'ok', extra: true })).toEqual({ action: 'stop', reason: 'ok' });
  });
});

describe('turn events', () => {
  it('counts exactly the nine Telegram tools that put something in front of the user as visible', () => {
    const names = ['send_message', 'reply_to_message', 'edit_message', 'add_reaction', 'send_photo', 'send_memory_document', 'create_poll', 'stop_poll', 'delete_message'];
    expect([...USER_VISIBLE_TOOLS].sort()).toEqual(names.map((n) => `mcp__tars__telegram_${n}`).sort());
  });

  it('collects text, keys visibility on delivery tools, takes control from StructuredOutput', () => {
    const t = turn();
    t.turn.addAssistant(assistant({ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'hello' }, { type: 'text', text: '' }));
    t.turn.addAssistant(assistant(toolUse('mcp__tars__telegram_add_reaction', { emoji: '👍' }), toolUse('StructuredOutput', { action: 'stop', reason: 'reacted' })));
    const result = t.turn.finish({ type: 'result', result: '' });
    expect(result).toMatchObject({ textBlocks: ['hello'], userVisibleAction: true, droppedText: false, control: { action: 'stop', reason: 'reacted' } });
    expect(t.log.text()).toContain('[CC.text] (thinking) hmm');
    expect(t.log.text()).toContain('[CC.tool→] mcp__tars__telegram_add_reaction({"emoji":"👍"}) id=toolu_ab');
    expect(t.log.text()).toContain('[CC.done] action=stop reason=reacted');
  });

  it('marks text without any user-visible tool as dropped, even with a control action', () => {
    const t = turn();
    t.turn.addAssistant(assistant({ type: 'text', text: 'the reply' }, toolUse('StructuredOutput', { action: 'stop', reason: 'replied' })));
    expect(t.turn.finish({ type: 'result' })).toMatchObject({ droppedText: true, userVisibleAction: false });
  });

  it('warns about an invalid StructuredOutput and keeps the previous control', () => {
    const t = turn();
    t.turn.addAssistant(assistant(toolUse('StructuredOutput', { action: 'stop' })));
    expect(t.turn.finish({ type: 'result' }).control).toBeUndefined();
    expect(t.log.text()).toContain('WARNING could not parse StructuredOutput input: {"action":"stop"}');
  });

  it('consumes control JSON from the last text block, but keeps prose when the result carries text', () => {
    const t = turn();
    t.turn.addAssistant(assistant({ type: 'text', text: 'prose' }, { type: 'text', text: '{"action": "skip", "reason": "chatter"}' }));
    expect(t.turn.finish({ type: 'result', result: '' })).toMatchObject({ textBlocks: ['prose'], control: { action: 'skip' } });
    const kept = turn();
    kept.turn.addAssistant(assistant({ type: 'text', text: 'prose' }));
    expect(kept.turn.finish({ type: 'result', result: 'final words' })).toMatchObject({ textBlocks: ['prose'], control: undefined });
    const unparseable = turn();
    unparseable.turn.addAssistant(assistant({ type: 'text', text: 'not json' }));
    expect(unparseable.turn.finish({ type: 'result' })).toMatchObject({ textBlocks: ['not json'], control: undefined, droppedText: true });
  });

  it('turns an is_error result into an API error', () => {
    expect(turn().turn.finish({ type: 'result', is_error: true, result: 'Usage Policy' }).apiError).toBe('Usage Policy');
    expect(turn().turn.finish({ type: 'result', is_error: true, result: '' }).apiError).toBe('unknown API error');
    expect(turn().turn.finish({ type: 'result', is_error: false }).apiError).toBeUndefined();
  });

  it('reports each tool result and its error flag', () => {
    const t = turn();
    const flags = t.turn.toolResults({ message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, { type: 'tool_result', tool_use_id: 'toolu_2', content: 'boom', is_error: true }] } });
    expect(flags).toEqual([false, true]);
    expect(t.log.text()).toContain('[CC.tool✓] id=toolu_1 | a b');
    expect(t.log.text()).toContain('[CC.tool✗] id=toolu_2 | boom');
  });

  it('builds abort sentinels with the partial text', () => {
    const t = turn();
    t.turn.addAssistant(assistant({ type: 'text', text: 'half' }));
    t.turn.stderr.push('warn');
    expect(t.turn.abort('liveness-wedge')).toEqual({ textBlocks: ['half'], stderrTail: ['warn'], userVisibleAction: false, droppedText: false, abortedReason: 'liveness-wedge' });
  });
});

describe('stream-json helpers', () => {
  it('writes one compact JSON user message line', () => {
    expect(userLine('Ўз "hi"')).toBe('{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Ўз \\"hi\\""}]}}\n');
  });

  it('relays top-level errors, with transparent API retries as warnings', () => {
    const log = memoryLogger();
    relayError({ type: 'result', subtype: 'success', is_error: true, api_error_status: 529 }, log);
    relayError({ type: 'system', subtype: 'api_retry', error: 'overloaded' }, log);
    relayError({ type: 'assistant' }, log);
    expect(log.text()).toBe('ERROR cc reported error in result/success event: is_error=true, api_error_status=529\nWARNING cc reported error in system/api_retry event: error=overloaded');
  });

  it('lists MCP servers that did not connect', () => {
    expect(failedMcpServers({ mcp_servers: [{ name: 'tars', status: 'connected' }, { name: 'gh', status: 'failed' }, 'junk', { status: 'pending' }] })).toEqual([
      { name: 'gh', status: 'failed' },
      { name: '?', status: 'pending' },
    ]);
    expect(failedMcpServers({})).toEqual([]);
  });
});
