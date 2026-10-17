const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };

/** HTML-escape text, quotes included. */
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => ESCAPES[ch] ?? ch);

/** Strip tags and decode the entities `escapeHtml` produces, plus numeric ones. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, body: string) => decodeEntity(entity, body.toLowerCase()));
}

function decodeEntity(entity: string, body: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  if (body in named) return named[body] ?? entity;
  const code = body.startsWith('#x') ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
  return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
}
