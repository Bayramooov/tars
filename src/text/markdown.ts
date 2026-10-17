import { escapeHtml } from './html.ts';

// Word characters are Unicode (JS's `\w` is ASCII-only), and line anchors only
// recognise "\n" (JS's `m` flag also treats "\r" and U+2028 as line breaks).
const WORD = String.raw`[\p{L}\p{N}_]`;
const BOL = String.raw`(?<![^\n])`;
const EOL = String.raw`(?![^\n])`;

const FENCE = '```';
// A language tag only counts when a newline follows it: ```npm install x``` is all code.
const CODE_BLOCK = new RegExp(String.raw`${FENCE}(?:(${WORD}+)?\n)?([\s\S]*?)${FENCE}`, 'gu');
const INLINE_CODE = /`([^`]+)`/g;
const HR = new RegExp(String.raw`${BOL}[ \t]*(?:-{3,}|={3,}|\*{3,})[ \t]*${EOL}`, 'g');
const LIST = new RegExp(String.raw`${BOL}([ \t]*)[-*+] `, 'g');
const IMAGE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const SEP_CELL = /^[ \t]*:?-+:?[ \t]*$/;
const UNDERSCORE_ITALIC = new RegExp(String.raw`(?<!${WORD})_([^\n]+?)_(?!${WORD})`, 'gu');
const HEADING = new RegExp(String.raw`${BOL}#{1,6}\s+`, 'g');
const BLOCKQUOTE = new RegExp(String.raw`(?:${BOL}&gt;[ \t]?[^\n]*(?:\n|$))+`, 'g');
const QUOTE_MARK = new RegExp(String.raw`${BOL}&gt;[ \t]?`, 'g');
const TAG = /<(\/?)([a-zA-Z][^\s/>]*)[^>]*>/g;

/**
 * Best-effort Markdown → Telegram HTML (the subset Telegram's parser accepts).
 * Crossed emphasis (`**a *b** c*`) would make Telegram reject the whole
 * message, so when the result isn't well-formed it is re-rendered with
 * emphasis left as literal text.
 */
export function markdownToTelegramHtml(text: string): string {
  const rendered = render(text, true);
  return isWellFormed(rendered) ? rendered : render(text, false);
}

function render(text: string, emphasis: boolean): string {
  const blocks: string[] = [];
  const codes: string[] = [];
  let out = text.replace(CODE_BLOCK, (_m, lang: string | undefined, code: string) => {
    const body = escapeHtml(code.replace(/\n+$/, ''));
    blocks.push(lang ? `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>` : `<pre>${body}</pre>`);
    return `\0CODEBLOCK${blocks.length - 1}\0`;
  });
  out = out.replace(INLINE_CODE, (_m, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\0INLINECODE${codes.length - 1}\0`;
  });
  out = escapeHtml(sanitizeUnsupported(out));
  if (emphasis) out = applyEmphasis(out);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>').replace(HEADING, '');
  out = out.replace(BLOCKQUOTE, (block) => `<blockquote>${block.replace(/\n+$/, '').replace(QUOTE_MARK, '')}</blockquote>\n`);
  // Function replacers: a literal "$&" inside user code must stay literal.
  blocks.forEach((html, i) => (out = out.replaceAll(`\0CODEBLOCK${i}\0`, () => html)));
  codes.forEach((html, i) => (out = out.replaceAll(`\0INLINECODE${i}\0`, () => html)));
  return out;
}

/** Tables → `•` rows, rules → blank, list markers → `•`, images → links. */
function sanitizeUnsupported(text: string): string {
  return tablesToBullets(text).replace(HR, '').replace(LIST, '$1• ').replace(IMAGE, '[$1]($2)');
}

/** Greedier markers first: bold+italic, then bold, then italic, then strike. */
function applyEmphasis(text: string): string {
  return text
    .replace(/\*\*\*([^\n]+?)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/__([^\n]+?)__/g, '<b>$1</b>')
    .replace(/\*([^\n]+?)\*/g, '<i>$1</i>')
    .replace(UNDERSCORE_ITALIC, '<i>$1</i>')
    .replace(/~~([^\n]+?)~~/g, '<s>$1</s>');
}

function tablesToBullets(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!(isTableRow(lines[i]) && isSeparatorRow(lines[i + 1]))) {
      out.push(lines[i++] ?? '');
      continue;
    }
    for (; isTableRow(lines[i]); i++) {
      if (!isSeparatorRow(lines[i])) out.push(rowToBullet(lines[i] ?? ''));
    }
  }
  return out.join('\n');
}

function isTableRow(line: string | undefined): boolean {
  const s = line?.trim() ?? '';
  return s.length >= 2 && s.startsWith('|') && s.endsWith('|');
}

function isSeparatorRow(line: string | undefined): boolean {
  if (!isTableRow(line)) return false;
  return (line ?? '').trim().slice(1, -1).split('|').every((cell) => SEP_CELL.test(cell));
}

function rowToBullet(line: string): string {
  const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim()).filter(Boolean);
  return `• ${cells.join(' — ')}`;
}

/** True when every tag is closed in order — Telegram rejects crossed tags. */
function isWellFormed(html: string): boolean {
  const stack: string[] = [];
  for (const [, closing, name] of html.matchAll(TAG)) {
    const tag = (name ?? '').toLowerCase();
    if (!closing) stack.push(tag);
    else if (stack.pop() !== tag) return false;
  }
  return stack.length === 0;
}
