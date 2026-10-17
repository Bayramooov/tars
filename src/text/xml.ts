/** Escape element text: `&`, `<`, `>`. */
export const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Escape an attribute value for use inside double quotes. `"` is always
 * escaped: a display name like `Eve" user="1` must not be able to forge
 * envelope attributes.
 */
export const escapeAttr = (value: string) =>
  escapeXml(value).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;');
