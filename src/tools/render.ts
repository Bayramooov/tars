import { z } from 'zod';

import type { RenderRequest } from '../browser/render.ts';
import type { Logger } from '../log/logger.ts';
import { defineTool, type Tool, type ToolResult } from '../mcp/tool.ts';
import type { RenderStore } from '../stores/renders.ts';
import { escapeHtml } from '../text/html.ts';

export interface RenderDeps {
  /** Draw a page to PNG bytes (on the shared warm Chromium in production). */
  render(req: RenderRequest): Promise<Buffer>;
  store: Pick<RenderStore, 'save'>;
  log: Logger;
}

export function renderHtmlTool(deps: RenderDeps): Tool {
  return defineTool({
    name: 'render_html',
    description: 'Render an HTML snippet to a PNG via headless Chromium and save it under data/renders/. Returns the relative path; it is NOT sent — pair with telegram_send_photo to deliver it. Use for tables/charts/diffs Telegram markdown can\'t represent (it renders ASCII tables poorly); for math formulas use render_latex. Outbound network is BLOCKED in the browser, so inline any CSS/JS libs you need (Chart.js, D3, fonts). Renders synchronously with a ~30s budget.',
    args: z.object({
      html: z.string().min(1).describe('Full HTML body to render. Inline all CSS/JS — outbound network is blocked. Wrap with <!DOCTYPE html><html><body>...</body></html> for full control over fonts and viewport meta.'),
      width: z.int().min(200).max(4000).default(800).describe('Viewport width in pixels (default 800).'),
      height: z.int().min(200).max(4000).default(600).describe('Viewport height in pixels (default 600). Full page is captured regardless.'),
      title: z.string().max(80).nullable().default(null).describe('Optional human-readable label baked into the filename for easier identification.'),
    }),
    run: ({ html, width, height, title }) => renderToStore(deps, { html, width, height, waitUntil: 'domcontentloaded' }, title),
  });
}

export function renderLatexTool(deps: RenderDeps): Tool {
  return defineTool({
    name: 'render_latex',
    description: 'Render a LaTeX expression to a PNG via KaTeX. Use for math formulas, equations, integrals, matrices — anything LaTeX-native Telegram can\'t display inline; for general tables/charts use render_html. Returns the relative path under data/renders/; it is NOT sent — pair with telegram_send_photo to deliver. Pass the LaTeX without surrounding $$ (the wrapper adds them) and without a literal </script> token. Renders synchronously with a ~30s budget.',
    args: z.object({
      latex: z.string().max(8000).min(1).describe('LaTeX expression to render. Don\'t include the surrounding $$ delimiters — the wrapper adds them. Examples: ``\\sum_{i=0}^{n} i^2``, ``\\int_0^\\infty e^{-x^2} dx``, ``\\begin{align} a &= b \\\\ c &= d \\end{align}``.'),
      title: z.string().max(80).nullable().default(null).describe('Optional human-readable label. Rendered as an h2 above the formula and baked into the output filename.'),
    }),
    run: async ({ latex, title }) => {
      if (latex.toLowerCase().includes('</script')) return { content: 'latex contains a forbidden token (</script)', isError: true };
      const req: RenderRequest = { html: latexPage(latex, title), width: 900, height: 400, allowedHosts: ['cdn.jsdelivr.net'], waitUntil: 'networkidle' };
      return await renderToStore(deps, req, title || 'latex');
    },
  });
}

/** Render, save the PNG and report it; a failed render is an error result, not an exception. */
async function renderToStore(deps: RenderDeps, req: RenderRequest, title: string | null): Promise<ToolResult> {
  let png: Buffer;
  try {
    png = await deps.render(req);
  } catch (err) {
    const reason = (err as Error).message;
    deps.log.warn(`render_html failed: ${reason}`);
    return { content: `render failed: ${reason}`, isError: true };
  }
  if (!png.length) return { content: 'render produced no output', isError: true };
  const path = deps.store.save(title, png);
  deps.log.info(`rendered html → ${path} (${png.length} bytes, ${req.width}x${req.height})`);
  return {
    content: `rendered to ${path} (${png.length} bytes). Pass this path to telegram_send_photo to deliver it.`,
    data: { path, size_bytes: png.length, width: req.width, height: req.height },
  };
}

/**
 * The KaTeX page. Auto-render
 * typesets `$$…$$` after load; the formula goes in raw (only the title is
 * escaped), and KaTeX is fetched from jsdelivr, the one host allowed.
 */
function latexPage(latex: string, title: string | null): string {
  const heading = title ? `<h2>${escapeHtml(title)}</h2>\n` : '';
  return `<!DOCTYPE html>
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
${heading}<div class="eq">$$${latex}$$</div>
</body></html>
`;
}
