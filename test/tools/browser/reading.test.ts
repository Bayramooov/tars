import { existsSync } from 'node:fs';

import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BrowserManager } from '../../../src/browser/manager.ts';
import { BrowserSession } from '../../../src/browser/session.ts';
import type { Tool } from '../../../src/mcp/tool.ts';
import { getAttributeTool, getHtmlTool, getTextTool, listTool, waitForTool } from '../../../src/tools/browser/reading.ts';
import { element, FakePage, fakeSession } from '../../fakes/browser.ts';
import { expectGoldenTool } from '../../golden/tools.ts';
import { memoryLogger } from '../../helpers/log.ts';

const call = (tool: Tool, raw: object) => tool.run(tool.args.parse(raw));
const LOCATE = { timeout: 5000 };
const MISS = 'no element matching ".gone" appeared in time (it may not be on this page — try a different selector)';

describe('browser reading tools', () => {
  it('match the golden tools/list entries', () => {
    const session = fakeSession();
    for (const tool of [getTextTool(session), getHtmlTool(session), getAttributeTool(session), listTool(session), waitForTool(session)]) expectGoldenTool(tool);
  });

  it('browser_get_text returns the body text, or one element’s', async () => {
    const page = Object.assign(new FakePage(), { text: 'the heading' });
    const tool = getTextTool(fakeSession(page));
    expect(await call(tool, {})).toEqual({ content: 'the heading', data: { chars: 11 } });
    await call(tool, { selector: 'h1' });
    expect(page.calls).toEqual([['innerText', 'body', LOCATE], ['innerText', 'h1', LOCATE]]);
  });

  it('browser_get_text truncates at 10000 characters (code points) and reports the full length', async () => {
    const huge = await call(getTextTool(fakeSession(Object.assign(new FakePage(), { text: 'x'.repeat(50_000) }))), {});
    expect(huge).toEqual({ content: `${'x'.repeat(10_000)}\n\n[truncated at 10000 chars]`, data: { chars: 50_000 } });
    const emoji = await call(getTextTool(fakeSession(Object.assign(new FakePage(), { text: '🙂'.repeat(10_001) }))), {});
    expect(emoji).toEqual({ content: `${'🙂'.repeat(10_000)}\n\n[truncated at 10000 chars]`, data: { chars: 10_001 } });
    const exact = await call(getTextTool(fakeSession(Object.assign(new FakePage(), { text: '🙂'.repeat(10_000) }))), {});
    expect(exact.content).toBe('🙂'.repeat(10_000));
  });

  it('browser_get_html returns the whole document, or one element’s inner HTML, truncated at 20000', async () => {
    const page = Object.assign(new FakePage(), { html: '<div>hi</div>' });
    const tool = getHtmlTool(fakeSession(page));
    expect(await call(tool, {})).toEqual({ content: '<div>hi</div>', data: { chars: 13 } });
    expect(await call(tool, { selector: '' })).toEqual({ content: '<div>hi</div>', data: { chars: 13 } });
    expect(page.calls).toEqual([['innerHTML', '', LOCATE]]);
    page.html = 'y'.repeat(20_001);
    expect(await call(tool, {})).toEqual({ content: `${'y'.repeat(20_000)}\n\n[truncated at 20000 chars]`, data: { chars: 20_001 } });
  });

  it('browser_get_attribute returns the raw value (even empty) or says it is absent', async () => {
    const page = Object.assign(new FakePage(), { attrs: { src: 'https://cdn/x.png', alt: '' } });
    const tool = getAttributeTool(fakeSession(page));
    expect(await call(tool, { selector: 'img', name: 'src' })).toEqual({ content: 'https://cdn/x.png', data: { value: 'https://cdn/x.png' } });
    expect(await call(tool, { selector: 'img', name: 'alt' })).toEqual({ content: '', data: { value: '' } });
    expect(await call(tool, { selector: "a[href='x']", name: 'title' })).toEqual({ content: `"a[href='x']" has no attribute "title"`, data: { value: null } });
    expect(page.calls[0]).toEqual(['getAttribute', 'img', 'src', LOCATE]);
  });

  it('browser_list lists text with href (else src), trimmed, one line each', async () => {
    const page = new FakePage();
    page.elements = [
      element('First', { href: '/a' }),
      element('  Second\nline  ', { href: '', src: '/img.png' }),
      element('Plain'),
      element('z'.repeat(130), { src: '' }),
    ];
    const result = await call(listTool(fakeSession(page)), { selector: 'a, img' });
    expect(result).toEqual({ content: `- First  [/a]\n- Second line  [/img.png]\n- Plain\n- ${'z'.repeat(120)}`, data: { count: 4 } });
  });

  it('browser_list reports no matches, and how many it left out past 50', async () => {
    const page = new FakePage();
    const tool = listTool(fakeSession(page));
    expect(await call(tool, { selector: 'a' })).toEqual({ content: '(no matches)', data: { count: 0 } });
    page.elements = Array.from({ length: 53 }, (_, i) => element(`item ${i}`));
    const { content, data } = await call(tool, { selector: 'a' });
    expect(content.split('\n')).toHaveLength(51);
    expect(content.endsWith('- item 49\n…(+3 more)')).toBe(true);
    expect(data).toEqual({ count: 53 });
  });

  it('browser_list lists a non-HTML element (no innerText) too', async () => {
    const page = Object.assign(new FakePage(), { elements: [element(undefined, { href: '#x' })] });
    expect(await call(listTool(fakeSession(page)), { selector: 'svg a' })).toEqual({ content: '-   [#x]', data: { count: 1 } });
  });

  it('browser_wait_for waits with the given budget (default 10 s, 1..30000)', async () => {
    const page = new FakePage();
    const tool = waitForTool(fakeSession(page));
    expect(await call(tool, { selector: '.results', timeout_ms: 5000 })).toEqual({ content: 'element ".results" is present' });
    await call(tool, { selector: '.results' });
    expect(page.calls).toEqual([['waitForSelector', '.results', { timeout: 5000 }], ['waitForSelector', '.results', { timeout: 10_000 }]]);
    expect(tool.args.safeParse({ selector: 'a', timeout_ms: 0 }).success).toBe(false);
    expect(tool.args.safeParse({ selector: 'a', timeout_ms: 30_001 }).success).toBe(false);
  });

  it('turn a selector that never shows up into a plain (non-error) miss', async () => {
    const session = fakeSession(Object.assign(new FakePage(), { missing: new Set(['.gone']) }));
    expect(await call(getTextTool(session), { selector: '.gone' })).toEqual({ content: `get_text: ${MISS}` });
    expect(await call(getHtmlTool(session), { selector: '.gone' })).toEqual({ content: `get_html: ${MISS}` });
    expect(await call(getAttributeTool(session), { selector: '.gone', name: 'src' })).toEqual({ content: `get_attribute: ${MISS}` });
    expect(await call(waitForTool(session), { selector: '.gone', timeout_ms: 8000 })).toEqual({ content: `wait_for: ${MISS}` });
  });

  it('ask for a navigate first', async () => {
    await expect(call(getTextTool(fakeSession()), {})).rejects.toThrow(new Error('no page open — call browser_navigate first'));
  });
});

describe.skipIf(!existsSync(chromium.executablePath()))('browser reading tools in Chromium', () => {
  const manager = new BrowserManager({ headless: true, log: memoryLogger() });
  const session = new BrowserSession({ manager, log: memoryLogger() });
  beforeAll(async () => {
    await (await session.ensurePage()).setContent(`<h1>Title</h1><p id="p">Body <b>text</b></p>
      <a href="/a"> First
      link </a><img src="/i.png" alt=""><svg><a href="#s"><text>svg</text></a></svg>
      <div id="late"></div><script>setTimeout(() => { document.getElementById('late').innerHTML = '<span class="ready">ok</span>' }, 200)</script>`);
  });
  afterAll(async () => {
    await session.close();
    await manager.close();
  });

  // against the real Playwright API
  it('read text, markup, attributes and lists from a live page', async () => {
    expect((await call(getTextTool(session), { selector: '#p' })).content).toBe('Body text');
    expect((await call(getHtmlTool(session), { selector: '#p' })).content).toBe('Body <b>text</b>');
    expect((await call(getHtmlTool(session), {})).content).toMatch(/^<html><head><\/head><body><h1>Title<\/h1>/);
    expect(await call(getAttributeTool(session), { selector: 'img', name: 'alt' })).toEqual({ content: '', data: { value: '' } });
    expect((await call(getAttributeTool(session), { selector: 'img', name: 'title' })).content).toBe('"img" has no attribute "title"');
    expect(await call(listTool(session), { selector: 'a[href="/a"], img' })).toEqual({ content: '- First link  [/a]\n-   [/i.png]', data: { count: 2 } });
    expect(await call(listTool(session), { selector: 'svg a' })).toEqual({ content: '- svg  [#s]', data: { count: 1 } });
    expect((await call(waitForTool(session), { selector: '.ready' })).content).toBe('element ".ready" is present');
    expect((await call(getTextTool(session), { selector: '.missing' })).content).toBe(
      'get_text: no element matching ".missing" appeared in time (it may not be on this page — try a different selector)',
    );
  });
});
