/** Invisible characters used to split keywords or hide instructions. */
const ZERO_WIDTH = new Set(['\u{200B}', '\u{200C}', '\u{200D}', '\u{2060}', '\u{FEFF}', '\u{AD}']);

/** Bidi embedding/override/isolate controls (not RTL letters themselves). */
const BIDI_CONTROLS = new Set(['\u{202A}', '\u{202B}', '\u{202C}', '\u{202D}', '\u{202E}', '\u{2066}', '\u{2067}', '\u{2068}', '\u{2069}']);

/** Flags surfaced to the model in the envelope's `flags=` attribute. */
export type InputFlag = 'nfkc_changed' | 'zero_width_stripped' | 'bidi_stripped';

/**
 * Defang hidden-character prompt injection: strip zero-width and bidi
 * controls, NFKC-normalise, and report which transforms fired.
 */
export function normalizeInbound(text: string): { text: string; flags: Set<InputFlag> } {
  const flags = new Set<InputFlag>();
  let kept = '';
  for (const ch of text) {
    if (ZERO_WIDTH.has(ch)) flags.add('zero_width_stripped');
    else if (BIDI_CONTROLS.has(ch)) flags.add('bidi_stripped');
    else kept += ch;
  }
  const nfkc = kept.normalize('NFKC');
  if (nfkc !== kept) flags.add('nfkc_changed');
  return { text: nfkc, flags };
}
