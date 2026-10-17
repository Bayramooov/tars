import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { chromium } from 'playwright';
import { afterAll, describe, expect, it } from 'vitest';

import { BrowserManager } from '../../src/browser/manager.ts';
import { type RenderRequest, renderPng } from '../../src/browser/render.ts';
import type { Tool } from '../../src/mcp/tool.ts';
import { RenderStore } from '../../src/stores/renders.ts';
import { renderHtmlTool, renderLatexTool } from '../../src/tools/render.ts';
import { expectGoldenTool } from '../golden/tools.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

const call = (tool: Tool, raw: object) => tool.run(tool.args.parse(raw));
const PNG = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(200, 'x')]);

/** Both tools over a fake renderer that records each request and answers with `draw()`. */
function setup(draw: () => Promise<Buffer> = () => Promise.resolve(PNG)) {
  const store = new RenderStore(join(tempDir(), 'renders'));
  const log = memoryLogger();
  const requests: RenderRequest[] = [];
  const render = (req: RenderRequest) => {
    requests.push(req);
    return draw();
  };
  return { store, log, requests, html: renderHtmlTool({ render, store, log }), latex: renderLatexTool({ render, store, log }) };
}

// The page render_latex builds, up to its body.
const KATEX_HEAD = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"
        onload="renderMathInElement(document.body)"></script>
<style>
  body{font-family:'Computer Modern',Georgia,serif;padding:40px;
       background:#fff;color:#111;font-size:24px;line-height:1.4}
  h2{margin:0 0 24px;font-weight:700;font-size:22px}
  .eq{padding:8px 0}
</style>
</head><body>
`;

describe('render_html', () => {
  it('matches the golden tools/list entries', () => {
    const { html, latex } = setup();
    expectGoldenTool(html);
    expectGoldenTool(latex);
  });

  it('renders at 800x600 by default with every request blocked, and saves the PNG', async () => {
    const { store, log, requests, html } = setup();
    const result = await call(html, { html: '<table><tr><td>hi</td></tr></table>', title: 'report' });
    const path = (result.data as { path: string }).path;
    expect(path).toMatch(/^\d{8}T\d{6}-report-[0-9a-f]{6}\.png$/);
    expect(result).toEqual({ content: `rendered to ${path} (208 bytes). Pass this path to telegram_send_photo to deliver it.`, data: { path, size_bytes: 208, width: 800, height: 600 } });
    expect(readFileSync(join(store.root, path))).toEqual(PNG);
    expect(requests).toEqual([{ html: '<table><tr><td>hi</td></tr></table>', width: 800, height: 600, waitUntil: 'domcontentloaded' }]);
    expect(log.text()).toBe(`INFO rendered html → ${path} (208 bytes, 800x600)`);
  });

  it('passes the viewport through and refuses one outside 200..4000', async () => {
    const { requests, html } = setup();
    await call(html, { html: '<p>hi</p>', width: 1200, height: 900 });
    expect(requests[0]).toMatchObject({ width: 1200, height: 900 });
    expect(html.args.safeParse({ html: '<p>x</p>', width: 10 }).success).toBe(false);
    expect(html.args.safeParse({ html: '<p>x</p>', height: 4001 }).success).toBe(false);
    expect(html.args.safeParse({ html: '' }).success).toBe(false);
  });

  // render failures are error results, not exceptions
  it('reports a failed render as an error result, logs it and saves nothing', async () => {
    const { store, log, html } = setup(() => Promise.reject(Object.assign(new Error('chromium crashed'), { name: 'RuntimeError' })));
    expect(await call(html, { html: '<p>x</p>' })).toEqual({ content: 'render failed: chromium crashed', isError: true });
    expect(log.text()).toBe('WARNING render_html failed: chromium crashed');
    expect(readdirSync(store.root)).toEqual([]);
  });

  it('reports an empty screenshot as no output and saves nothing', async () => {
    const { store, html } = setup(() => Promise.resolve(Buffer.alloc(0)));
    expect(await call(html, { html: '<p>x</p>' })).toEqual({ content: 'render produced no output', isError: true });
    expect(readdirSync(store.root)).toEqual([]);
  });
});

describe('render_latex', () => {
  it('renders the KaTeX page at 900x400, letting only jsdelivr through and waiting for the network to settle', async () => {
    const { requests, latex } = setup();
    const result = await call(latex, { latex: 'E = mc^2', title: "My <Eq> 'x' & \"q\"" });
    expect(requests).toEqual([
      {
        html: `${KATEX_HEAD}<h2>My &lt;Eq&gt; &#x27;x&#x27; &amp; &quot;q&quot;</h2>\n<div class="eq">$$E = mc^2$$</div>\n</body></html>\n`,
        width: 900,
        height: 400,
        allowedHosts: ['cdn.jsdelivr.net'],
        waitUntil: 'networkidle',
      },
    ]);
    expect((result.data as { path: string }).path).toMatch(/^\d{8}T\d{6}-my-eq-x-q-[0-9a-f]{6}\.png$/);
    expect(result.data).toMatchObject({ width: 900, height: 400 });
  });

  // no title, no heading; the file is named after "latex"
  it('puts the formula in raw and names the file "latex" without a title', async () => {
    const { requests, latex } = setup();
    const result = await call(latex, { latex: '\\sum_{i=0}^{n} i^2' });
    expect(requests[0]?.html).toBe(`${KATEX_HEAD}<div class="eq">$$\\sum_{i=0}^{n} i^2$$</div>\n</body></html>\n`);
    expect((result.data as { path: string }).path).toMatch(/^\d{8}T\d{6}-latex-[0-9a-f]{6}\.png$/);
  });

  it('refuses a literal </script before rendering', async () => {
    const { requests, latex } = setup();
    expect(await call(latex, { latex: 'x </SCRIPT> y' })).toEqual({ content: 'latex contains a forbidden token (</script)', isError: true });
    expect((await call(latex, { latex: 'x < /script> y' })).content).toContain('rendered to');
    expect(requests).toHaveLength(1);
  });

  // up to 80 characters, counted as code points
  it('limits the title to 80 characters', async () => {
    const { requests, latex } = setup();
    await call(latex, { latex: 'x', title: '🙂'.repeat(80) });
    expect(requests).toHaveLength(1);
    expect(latex.args.safeParse({ latex: 'x', title: 'a'.repeat(81) }).success).toBe(false);
  });

  // up to 8000 characters, counted as code points
  it('limits the formula to 8000 characters', () => {
    const { latex } = setup();
    expect(latex.args.safeParse({ latex: '𝔸'.repeat(8000) }).success).toBe(true);
    expect(latex.args.safeParse({ latex: 'x'.repeat(8001) }).success).toBe(false);
    expect(latex.args.safeParse({ latex: '' }).success).toBe(false);
  });
});

describe.skipIf(!existsSync(chromium.executablePath()))('render_html in Chromium', () => {
  const manager = new BrowserManager({ headless: true, log: memoryLogger() });
  afterAll(() => manager.close());

  // real Chromium, real store
  it('renders a table to a PNG file telegram_send_photo can pick up', async () => {
    const store = new RenderStore(join(tempDir(), 'renders'));
    const log = memoryLogger();
    const tool = renderHtmlTool({ render: (req) => renderPng(manager, req, log), store, log });
    const html = '<!DOCTYPE html><html><body><h2>Q3 Sales</h2><table><tr><th>Region</th><th>Revenue</th></tr><tr><td>EMEA</td><td>$1.2M</td></tr></table></body></html>';
    const result = await call(tool, { html, title: 'q3-sales' });
    const path = (result.data as { path: string }).path;
    const png = readFileSync(store.resolvePath(path));
    expect(png.subarray(0, 8).toString('latin1')).toBe('\x89PNG\r\n\x1a\n');
    expect(png.length).toBeGreaterThan(1000);
    expect(store.isFile(store.resolvePath(path))).toBe(true);
  });
});
