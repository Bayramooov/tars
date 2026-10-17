import { describe, expect, it } from 'vitest';

import { formatMessageRefs, messageLink, messageRef } from '../../src/telegram/links.ts';
import { chunkMarkdown, chunkText } from '../../src/text/chunk.ts';
import { parseFrontmatter, renderFrontmatter, requireNameAndDescription } from '../../src/text/frontmatter.ts';
import { markdownToTelegramHtml } from '../../src/text/markdown.ts';
import { normalizeInbound } from '../../src/text/normalize.ts';
import { containsSecret, scrub } from '../../src/text/scrub.ts';
import { type GoldenMsg, loadGolden, toChatMessage } from './load.ts';

interface Golden {
  chunk_text: { text: string; limit: number; out: string[] }[];
  chunk_text_astral: { text: string; limit: number }[];
  markdown_to_telegram_html: { in: string; out: string }[];
  normalize_inbound: { in: string; out: string; flags: string[] }[];
  scrub: { in: string; out: string; contains: boolean }[];
  message_link: { chat_id: number; message_id: number; out: string | null }[];
  message_ref: { msg: GoldenMsg; title: string | null; out: string }[];
  format_message_refs: { targets: GoldenMsg[]; titles: Record<string, string>; out: string; empty: string };
  frontmatter: {
    parse: { in: string; meta?: Record<string, unknown>; body?: string; message?: string }[];
    validate: { meta: Record<string, unknown>; ok?: boolean; message?: string }[];
    render: { meta: Record<string, unknown>; out: string }[];
  };
}

const golden = loadGolden<Golden>('utils.json');

describe('chunkText (golden)', () => {
  it.each(golden.chunk_text.map((c, i) => [i, c] as const))('case %i', (_i, c) => {
    expect(chunkText(c.text, c.limit)).toEqual(c.out);
  });

  // Telegram counts UTF-16 units, so astral-heavy text is cut where no chunk can pass the real limit.
  it.each(golden.chunk_text_astral.map((c, i) => [i, c] as const))('astral case %i stays within UTF-16 limit', (_i, c) => {
    const chunks = chunkText(c.text, c.limit);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(c.limit);
      expect(chunk).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
    }
  });
});

describe('chunkMarkdown', () => {
  it('closes a code block cut between chunks and reopens it in the next, language kept', () => {
    const code = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkMarkdown(`Here:\n\n\`\`\`ts\n${code}\n\`\`\`\nafter`, 150);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks.filter((c) => c.includes('line'))) expect(markdownToTelegramHtml(chunk)).toMatch(/^<pre><code class="language-ts">line/);
  });
});

describe('markdownToTelegramHtml (golden)', () => {
  it.each(golden.markdown_to_telegram_html.map((c) => [c.in, c.out] as const))('%j', (input, out) => {
    expect(markdownToTelegramHtml(input)).toBe(out);
  });
});

describe('normalizeInbound (golden)', () => {
  it.each(golden.normalize_inbound.map((c) => [c.in, c] as const))('%j', (_in, c) => {
    const { text, flags } = normalizeInbound(c.in);
    expect({ text, flags: [...flags].sort() }).toEqual({ text: c.out, flags: c.flags });
  });
});

describe('scrub (golden)', () => {
  it.each(golden.scrub.map((c) => [c.in, c] as const))('%j', (_in, c) => {
    expect(scrub(c.in)).toBe(c.out);
    expect(containsSecret(c.in)).toBe(c.contains);
  });

  it('stays linear on key headers that never close (an attachment could freeze the bot)', () => {
    const text = '-----BEGIN PRIVATE KEY-----\n'.repeat(40_000);
    const started = performance.now();
    expect(scrub(text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('telegram links (golden)', () => {
  it('messageLink', () => {
    for (const c of golden.message_link) expect(messageLink(c.chat_id, c.message_id)).toBe(c.out ?? undefined);
  });

  it('messageRef', () => {
    for (const c of golden.message_ref) expect(messageRef(toChatMessage(c.msg), c.title ?? undefined)).toBe(c.out);
  });

  it('formatMessageRefs', () => {
    const g = golden.format_message_refs;
    const targets = new Map(g.targets.map((m) => [m.chat_id, toChatMessage(m)] as const));
    const titles = new Map(Object.entries(g.titles).map(([k, v]) => [Number(k), v] as const));
    expect(formatMessageRefs(targets, titles)).toBe(g.out);
    expect(formatMessageRefs(new Map(), titles)).toBe(g.empty);
  });
});

describe('frontmatter (golden)', () => {
  const plain = (meta: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v]));

  it.each(golden.frontmatter.parse.map((c) => [c.in, c] as const))('parse %j', (_in, c) => {
    if (c.message === undefined) {
      const { meta, body } = parseFrontmatter(c.in, 'memory file');
      expect({ meta: plain(meta), body }).toEqual({ meta: c.meta, body: c.body });
    } else if (c.message.includes('not valid YAML')) {
      expect(() => parseFrontmatter(c.in, 'memory file')).toThrow('memory file frontmatter is not valid YAML: ');
    } else {
      expect(() => parseFrontmatter(c.in, 'memory file')).toThrow(c.message);
    }
  });

  it.each(golden.frontmatter.validate.map((c) => [JSON.stringify(c.meta).slice(0, 60), c] as const))('validate %s', (_k, c) => {
    const run = () => requireNameAndDescription(c.meta, 'SKILL.md');
    if (c.ok) expect(run).not.toThrow();
    else expect(run).toThrow(c.message);
  });

  it.each(golden.frontmatter.render.map((c) => [c.meta.name as string, c] as const))('render %s', (_name, c) => {
    expect(renderFrontmatter(c.meta as Record<string, string>)).toBe(c.out);
  });
});
