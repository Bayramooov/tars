/** Telegram's hard limit on one text message, in UTF-16 code units. */
export const TELEGRAM_TEXT_LIMIT = 4096;

/**
 * Split `text` into chunks of at most `limit` UTF-16 units — the unit Telegram
 * counts in. Prefers a paragraph break, then a line break, then a space; the
 * separator at a cut is consumed, never carried into the next chunk. A hard
 * cut never splits a surrogate pair. Empty input returns `[""]`.
 */
export function chunkText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const sep = ['\n\n', '\n', ' '].find((s) => window.lastIndexOf(s) > 0);
    if (sep === undefined) {
      const cut = isHighSurrogate(rest.charCodeAt(limit - 1)) && limit > 1 ? limit - 1 : limit;
      chunks.push(rest.slice(0, cut));
      rest = rest.slice(cut);
      continue;
    }
    const idx = window.lastIndexOf(sep);
    chunks.push(rest.slice(0, idx));
    // A "\n\n" straddling the window edge was seen as a single "\n": swallow
    // the adjacent newlines too so the next chunk doesn't start with one.
    let next = idx + sep.length;
    while (rest[next] === '\n') next++;
    rest = rest.slice(next);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * `chunkText` for Markdown: a ``` code block cut between two chunks is closed
 * at the end of one and reopened, with its language, at the start of the
 * next, so every chunk renders on its own. The added fences render as markup,
 * not text, so Telegram's limit still holds.
 */
export function chunkMarkdown(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  let reopen = '';
  return chunkText(text, limit).map((chunk) => {
    const whole = reopen + chunk;
    const fences = whole.match(/```[\p{L}\p{N}_]*/gu) ?? [];
    const open = fences.length % 2 === 1 ? fences.at(-1) : undefined;
    reopen = open === undefined ? '' : `${open}\n`;
    return open === undefined ? whole : `${whole}\n\`\`\``;
  });
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
