import { parse, stringify } from 'yaml';

/** Agent Skills caps, shared by skills and memory files. */
export const NAME_MAX = 64;
export const DESCRIPTION_MAX = 1024;

const BLOCK = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;

/** Split the leading `---` YAML block from the markdown body; `label` names the file kind in errors. */
export function parseFrontmatter(text: string, label: string): { meta: Record<string, unknown>; body: string } {
  if (!text.startsWith('---')) throw new Error(`${label} must start with YAML frontmatter delimiter '---'`);
  const match = BLOCK.exec(text);
  if (!match) throw new Error(`${label} frontmatter block is not closed with '---'`);
  let data: unknown;
  try {
    // CRLF files: without this a value would keep its trailing \r.
    data = parse((match[1] ?? '').replace(/\r\n?/g, '\n')) ?? {};
  } catch (err) {
    throw new Error(`${label} frontmatter is not valid YAML: ${(err as Error).message}`, { cause: err });
  }
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error(`${label} frontmatter must be a YAML mapping`);
  return { meta: data as Record<string, unknown>, body: text.slice(match[0].length) };
}

/** Enforce a non-empty `name` (≤ 64) and `description` (≤ 1024). */
export function requireNameAndDescription(meta: Record<string, unknown>, label: string): void {
  const { name, description } = meta;
  if (typeof name !== 'string' || !name) throw new Error(`${label} frontmatter must include a non-empty 'name' field`);
  if ([...name].length > NAME_MAX) throw new Error(`${label} name exceeds ${NAME_MAX} chars`);
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`${label} frontmatter must include a non-empty 'description' field`);
  }
  const length = [...description].length;
  if (length > DESCRIPTION_MAX) throw new Error(`${label} description exceeds ${DESCRIPTION_MAX} chars (${length})`);
}

/** Render `meta` as a `---` YAML block with a trailing newline; long values stay on one line. */
export const renderFrontmatter = (meta: Readonly<Record<string, string>>) => `---\n${stringify(meta, { lineWidth: 0 })}---\n`;
