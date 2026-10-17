import type { Logger } from '../log/logger.ts';
import { asText } from '../text/json.ts';
import { isRecord } from './turn.ts';

/** One stream-json user message line for Claude Code's stdin. */
export const userLine = (text: string) => `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;

/** MCP servers a `system/init` event reports as anything but connected. */
export function failedMcpServers(event: Record<string, unknown>): { name: string; status: string }[] {
  const servers = Array.isArray(event.mcp_servers) ? event.mcp_servers.filter(isRecord) : [];
  return servers.filter((s) => s.status !== 'connected').map((s) => ({ name: asText(s.name ?? '?'), status: asText(s.status) }));
}

/**
 * Log an error Claude Code reports at the top level of any non-tool event.
 * `system/api_retry` is its own transparent retry of an overloaded API — it
 * heals itself, so it is a warning, not an owner-alerting error.
 */
export function relayError(event: Record<string, unknown>, log: Logger): void {
  const bits = [
    event.is_error ? 'is_error=true' : '',
    event.api_error_status ? `api_error_status=${asText(event.api_error_status)}` : '',
    event.error ? `error=${asText(event.error)}` : '',
  ].filter(Boolean);
  if (!bits.length) return;
  const subtype = event.subtype ? asText(event.subtype) : '-';
  const message = `cc reported error in ${asText(event.type)}/${subtype} event: ${bits.join(', ')}`;
  if (event.type === 'system' && event.subtype === 'api_retry') log.warn(message);
  else log.error(message);
}
