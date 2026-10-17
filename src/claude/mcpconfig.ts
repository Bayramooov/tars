import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Logger } from '../log/logger.ts';
import type { Plugins } from '../plugins.ts';

/**
 * Write the `--mcp-config` file: the local tars server (always loaded, so
 * its tools never hide behind ToolSearch) plus every enabled external MCP.
 */
export function writeMcpConfig(tarsUrl: string, plugins: Pick<Plugins, 'mcps'>, log: Logger): string {
  const servers: Record<string, unknown> = { tars: { type: 'http', url: tarsUrl, alwaysLoad: true } };
  for (const mcp of plugins.mcps) {
    if (mcp.type === 'stdio') {
      servers[mcp.name] = { type: 'stdio', command: mcp.command, args: mcp.args, env: mcp.env };
      log.info(`mcp ${mcp.name} configured (type=stdio, command=${mcp.command})`);
    } else {
      servers[mcp.name] = { type: mcp.type, url: mcp.url, ...(Object.keys(mcp.headers).length ? { headers: mcp.headers } : {}) };
      log.info(`mcp ${mcp.name} configured (type=${mcp.type}, url=${mcp.url})`);
    }
  }
  const path = join(mkdtempSync(join(tmpdir(), 'tars-')), 'mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers: servers }, null, 2));
  log.info(`mcp config written to ${path}`);
  return path;
}
