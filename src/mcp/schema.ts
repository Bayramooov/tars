import { z } from 'zod';

type Json = Record<string, unknown>;

const SAFE_INT_BOUNDS = new Set([Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);

/** The JSON Schema `tools/list` advertises for a tool's arguments. */
export function inputSchema(args: z.ZodObject): Json {
  const schema = z.toJSONSchema(args, { io: 'input' }) as Json;
  delete schema.$schema;
  stripSafeIntBounds(schema);
  return schema;
}

/** zod writes ±MAX_SAFE_INTEGER bounds on every int: tokens in every schema the model reads, for no information. */
function stripSafeIntBounds(node: unknown): void {
  if (Array.isArray(node)) return node.forEach(stripSafeIntBounds);
  if (typeof node !== 'object' || node === null) return;
  const record = node as Json;
  for (const key of ['minimum', 'maximum']) if (SAFE_INT_BOUNDS.has(record[key] as number)) delete record[key];
  Object.values(record).forEach(stripSafeIntBounds);
}
