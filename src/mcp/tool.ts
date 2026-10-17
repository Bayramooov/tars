import type { z } from 'zod';

/** What a tool hands back: `content` is all the model sees; `data` goes only to the audit log. */
export interface ToolResult {
  content: string;
  data?: unknown;
  isError?: boolean;
  /** An image file to return as an MCP image block instead of text. */
  imagePath?: string | undefined;
}

/** One MCP tool: a bare name (Claude sees `mcp__tars__<name>`), a description, and zod-typed arguments. */
export interface Tool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  args: z.ZodObject<Shape>;
  run(args: z.output<z.ZodObject<Shape>>): Promise<ToolResult>;
}

/** Type-checks a tool definition against its own argument schema. */
export const defineTool = <Shape extends z.ZodRawShape>(tool: Tool<Shape>): Tool => tool;

/**
 * Run a store call; a failure becomes an error result carrying its message,
 * so the audit row records a result rather than an exception.
 */
export function storeResult(call: () => ToolResult): Promise<ToolResult> {
  try {
    return Promise.resolve(call());
  } catch (err) {
    return Promise.resolve({ content: (err as Error).message, isError: true });
  }
}
