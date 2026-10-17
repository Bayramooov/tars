import { existsSync } from 'node:fs';

import { chromium } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';

import { BrowserManager } from '../../../src/browser/manager.ts';
import { BrowserSession } from '../../../src/browser/session.ts';
import type { Tool } from '../../../src/mcp/tool.ts';
import { clickTool, fillTool, pressKeyTool, scrollTool, selectOptionTool } from '../../../src/tools/browser/actions.ts';
import { FakePage, fakeSession } from '../../fakes/browser.ts';
import { expectGoldenTool } from '../../golden/tools.ts';
import { memoryLogger } from '../../helpers/log.ts';

const call = (tool: Tool, raw: object) => tool.run(tool.args.parse(raw));
const ACTION = { timeout: 10_000 };
const MISS = 'no element matching "button.gone" appeared in time (it may not be on this page — try a different selector)';

describe('browser action tools', () => {
  it('match the golden tools/list entries', () => {
    const session = fakeSession();
    for (const tool of [clickTool(session), fillTool(session), pressKeyTool(session), selectOptionTool(session), scrollTool(session)]) expectGoldenTool(tool);
  });

  it('browser_click clicks the first match, waiting up to 10 s', async () => {
    const page = new FakePage();
    expect(await call(clickTool(fakeSession(page)), { selector: "a[href='x']" })).toEqual({ content: `clicked "a[href='x']"` });
    expect(page.calls).toEqual([['click', "a[href='x']", ACTION]]);
  });

  it('browser_fill types the value without echoing it', async () => {
    const page = new FakePage();
    expect(await call(fillTool(fakeSession(page)), { selector: 'input[name=q]', value: 'secret' })).toEqual({ content: 'filled "input[name=q]"' });
    expect(page.calls).toEqual([['fill', 'input[name=q]', 'secret', ACTION]]);
  });

  it('browser_press_key presses on a selector, or on the focused element without one', async () => {
    const page = new FakePage();
    const tool = pressKeyTool(fakeSession(page));
    expect(await call(tool, { key: 'Enter', selector: 'input[name=q]' })).toEqual({ content: 'pressed "Enter"' });
    expect(await call(tool, { key: 'Escape' })).toEqual({ content: 'pressed "Escape"' });
    expect(await call(tool, { key: 'Tab', selector: '' })).toEqual({ content: 'pressed "Tab"' });
    expect(page.calls).toEqual([['press', 'input[name=q]', 'Enter', ACTION], ['keyboard.press', 'Escape'], ['press', '', 'Tab', ACTION]]);
  });

  it('browser_select_option reports the selected values as data', async () => {
    const page = new FakePage();
    const result = await call(selectOptionTool(fakeSession(page)), { selector: 'select#c', value: 'usd' });
    expect(result).toEqual({ content: 'selected "usd" in "select#c"', data: { selected: ['usd'] } });
    expect(page.calls).toEqual([['selectOption', 'select#c', 'usd', ACTION]]);
  });

  it('browser_scroll wheels the window by pixels (default 1000, negative is up) or scrolls an element into view', async () => {
    const page = new FakePage();
    const tool = scrollTool(fakeSession(page));
    expect(await call(tool, {})).toEqual({ content: 'scrolled 1000px' });
    expect(await call(tool, { pixels: -300 })).toEqual({ content: 'scrolled -300px' });
    expect(await call(tool, { selector: '.target' })).toEqual({ content: 'scrolled ".target" into view' });
    expect(page.calls).toEqual([['mouse.wheel', 0, 1000], ['mouse.wheel', 0, -300], ['locator.scrollIntoViewIfNeeded', '.target', ACTION]]);
  });

  it('turn a selector that never shows up into a plain (non-error) miss', async () => {
    const page = Object.assign(new FakePage(), { missing: new Set(['button.gone']) });
    const session = fakeSession(page);
    expect(await call(clickTool(session), { selector: 'button.gone' })).toEqual({ content: `click: ${MISS}` });
    expect(await call(fillTool(session), { selector: 'button.gone', value: 'x' })).toEqual({ content: `fill: ${MISS}` });
    expect(await call(pressKeyTool(session), { key: 'Enter', selector: 'button.gone' })).toEqual({ content: `press_key: ${MISS}` });
    expect(await call(selectOptionTool(session), { selector: 'button.gone', value: 'x' })).toEqual({ content: `select_option: ${MISS}` });
    expect(await call(scrollTool(session), { selector: 'button.gone' })).toEqual({ content: `scroll: ${MISS}` });
  });

  it('let any other failure through as a real tool error', async () => {
    const page = Object.assign(new FakePage(), { click: () => Promise.reject(new Error('page.click: Target page, context or browser has been closed')) });
    await expect(call(clickTool(fakeSession(page)), { selector: 'a' })).rejects.toThrow('Target page, context or browser has been closed');
  });

  it('ask for a navigate first', async () => {
    await expect(call(clickTool(fakeSession()), { selector: 'a' })).rejects.toThrow(new Error('no page open — call browser_navigate first'));
  });

  // C2: empty selectors and values are refused by the schema, an empty fill value is not
  it('validate arguments in their schemas', () => {
    const session = fakeSession();
    expect(clickTool(session).args.safeParse({ selector: '' }).success).toBe(false);
    expect(selectOptionTool(session).args.safeParse({ selector: 's', value: '' }).success).toBe(false);
    expect(fillTool(session).args.safeParse({ selector: 's', value: '' }).success).toBe(true);
    expect(pressKeyTool(session).args.safeParse({ key: '' }).success).toBe(false);
  });
});

describe.skipIf(!existsSync(chromium.executablePath()))('browser action tools in Chromium', () => {
  const manager = new BrowserManager({ headless: true, log: memoryLogger() });
  const session = new BrowserSession({ manager, log: memoryLogger() });
  afterAll(async () => {
    await session.close();
    await manager.close();
  });

  // against the real Playwright API
  it('click, fill, press, select and scroll on a live page', async () => {
    const page = await session.ensurePage();
    await page.setContent(`<button onclick="this.textContent='done'">go</button><input id="q" onkeydown="if (event.key === 'Enter') this.dataset.sent = this.value">
      <select id="c"><option value="a">Alpha</option><option value="b">Beta</option></select><div style="height:3000px"></div><p id="end">end</p>`);
    await call(clickTool(session), { selector: 'button' });
    await call(fillTool(session), { selector: '#q', value: 'cats' });
    await call(pressKeyTool(session), { key: 'Enter', selector: '#q' });
    expect(await call(selectOptionTool(session), { selector: '#c', value: 'Beta' })).toEqual({ content: 'selected "Beta" in "#c"', data: { selected: ['b'] } });
    await call(scrollTool(session), { pixels: 500 });
    await page.waitForFunction('window.scrollY === 500');
    await call(scrollTool(session), { selector: '#end' });
    expect(await page.evaluate("[document.querySelector('button').textContent, document.querySelector('#q').dataset.sent, document.querySelector('#c').value, window.scrollY > 2000]")).toEqual([
      'done',
      'cats',
      'b',
      true,
    ]);
  });
});
