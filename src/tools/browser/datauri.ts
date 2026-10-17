/** The bytes of a `data:[<mediatype>][;base64],<data>` URI; the media type is ignored. */
export function decodeDataUri(url: string): Buffer {
  const comma = url.indexOf(',');
  if (comma < 0) throw new Error('malformed data: URI (no comma)');
  const data = url.slice(comma + 1);
  return url.slice(0, comma).endsWith(';base64') ? Buffer.from(data, 'base64') : percentDecode(data);
}

/** Each `%XX` becomes that byte; everything else, a stray `%` included, is kept as UTF-8. */
function percentDecode(text: string): Buffer {
  return Buffer.concat(text.split(/%([0-9A-Fa-f]{2})/).map((part, i) => (i % 2 ? Buffer.from([parseInt(part, 16)]) : Buffer.from(part))));
}
