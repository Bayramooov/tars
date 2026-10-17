/** A decoded JSON value as text: a string as it is, anything else as JSON. */
export function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}
