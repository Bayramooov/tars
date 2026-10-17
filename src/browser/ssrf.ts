import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/** Every address a host name resolves to; injectable so tests need no DNS. */
export type Resolve = (host: string) => Promise<string[]>;

const resolveAll: Resolve = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/**
 * The SSRF guard: throws unless `url` is http(s) and its host (an IP literal,
 * or every address it resolves to) is globally reachable. The host checked is
 * the WHATWG one Chromium connects to (`http://127.0.0.1\@evil.com/` is 127.0.0.1).
 */
export async function checkNavigable(url: string, resolve: Resolve = resolveAll): Promise<void> {
  const host = targetHost(url);
  for (const ip of await addresses(host, resolve)) {
    if (!isGlobal(ip)) throw new Error(`blocked: ${host} resolves to non-public address ${ip}`);
  }
}

/** The host Chromium would connect to; anything but an http(s) URL is refused. */
function targetHost(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed) throw new Error(`blocked: invalid URL ${JSON.stringify(url)}`);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`blocked: only http/https URLs allowed, got ${JSON.stringify(parsed.protocol.slice(0, -1))}`);
  }
  return parsed.hostname.replace(/^\[|\]$/g, '');
}

async function addresses(host: string, resolve: Resolve): Promise<string[]> {
  if (isIP(host)) return [host];
  try {
    return await resolve(host);
  } catch (err) {
    throw new Error(`blocked: cannot resolve ${host}: ${(err as Error).message}`, { cause: err });
  }
}

/** IANA special-purpose ranges that are not globally reachable. */
const NOT_GLOBAL = subnets([
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['240.0.0.0', 4],
  ['::1', 128], ['::', 128], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ['fc00::', 7], ['fe80::', 10],
]);

/** Addresses inside those ranges that are globally reachable after all. */
const GLOBAL_HOLES = subnets([
  ['192.0.0.9', 32], ['192.0.0.10', 32],
  ['2001:1::1', 128], ['2001:1::2', 128], ['2001:3::', 32], ['2001:4:112::', 48], ['2001:20::', 28], ['2001:30::', 28],
]);

function subnets(list: [string, number][]): BlockList {
  const block = new BlockList();
  for (const [net, prefix] of list) block.addSubnet(net, prefix, isIP(net) === 4 ? 'ipv4' : 'ipv6');
  return block;
}

/**
 * Whether `ip` is globally reachable. An IPv4-mapped IPv6 address
 * gets its IPv4 address's verdict (BlockList matches IPv4 rules against it);
 * brackets and a `%zone` suffix are ignored.
 */
export function isGlobal(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const version = isIP(bare);
  if (!version) return false; // not an address, so not a public one
  const family = version === 4 ? 'ipv4' : 'ipv6';
  return !NOT_GLOBAL.check(bare, family) || GLOBAL_HOLES.check(bare, family);
}
