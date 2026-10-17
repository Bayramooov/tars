/** A decoded JSON object: not null, not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A decoded JSON value as text: a string as it is, anything else as JSON. */
export function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}
