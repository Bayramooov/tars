/** The first `max` code points of `text`, and whether anything was cut — a cut never splits a surrogate pair. */
export function cpSlice(text: string, max: number): { text: string; cut: boolean } {
  const points = Array.from(text);
  return points.length > max ? { text: points.slice(0, max).join(''), cut: true } : { text, cut: false };
}

/** `text` cut to `max` code points, ending in `…` when anything was cut. */
export function clip(text: string, max: number): string {
  const { text: head, cut } = cpSlice(text, max);
  return cut ? `${head.trimEnd()}…` : text;
}
