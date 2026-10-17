import { describe, expect, it } from 'vitest';

import { checkNavigable, isGlobal, type Resolve } from '../../src/browser/ssrf.ts';

const NO_DNS: Resolve = (host) => Promise.reject(new Error(`unexpected lookup of ${host}`));

/** A resolver answering from a fixed table, recording what it was asked. */
function dns(table: Record<string, string[]>): Resolve & { asked: string[] } {
  const asked: string[] = [];
  const resolve = (host: string) => {
    asked.push(host);
    const ips = table[host];
    return ips ? Promise.resolve(ips) : Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`));
  };
  return Object.assign(resolve, { asked });
}

const blocked = (url: string, resolve: Resolve = NO_DNS) => checkNavigable(url, resolve).then(() => undefined, (err: Error) => `${err.name}: ${err.message}`);

describe('checkNavigable', () => {
  it.each([
    ['file:///etc/passwd', 'Error: blocked: only http/https URLs allowed, got "file"'],
    ['ftp://example.com/x', 'Error: blocked: only http/https URLs allowed, got "ftp"'],
    ['javascript:alert(1)', 'Error: blocked: only http/https URLs allowed, got "javascript"'],
    ['data:text/html,hi', 'Error: blocked: only http/https URLs allowed, got "data"'],
    ['example.com', 'Error: blocked: invalid URL "example.com"'],
    ['//example.com', 'Error: blocked: invalid URL "//example.com"'],
    ['/relative/path', 'Error: blocked: invalid URL "/relative/path"'],
    ['localhost:8080', 'Error: blocked: only http/https URLs allowed, got "localhost"'],
    ['example.com:443', 'Error: blocked: only http/https URLs allowed, got "example.com"'],
    ['h t t p://x', 'Error: blocked: invalid URL "h t t p://x"'],
    ['1http://x', 'Error: blocked: invalid URL "1http://x"'],
    ['http+unix://x/', 'Error: blocked: only http/https URLs allowed, got "http+unix"'],
    ['http://', 'Error: blocked: invalid URL "http://"'],
    ['http://:80/', 'Error: blocked: invalid URL "http://:80/"'],
    ['http://user@/', 'Error: blocked: invalid URL "http://user@/"'],
    ['http://[::1', 'Error: blocked: invalid URL "http://[::1"'],
    ['http://::1]/', 'Error: blocked: invalid URL "http://::1]/"'],
    ['ftp://[x', 'Error: blocked: invalid URL "ftp://[x"'],
    ['http://127.0.0.1/', 'Error: blocked: 127.0.0.1 resolves to non-public address 127.0.0.1'],
    ['http://10.0.0.5/', 'Error: blocked: 10.0.0.5 resolves to non-public address 10.0.0.5'],
    ['http://192.168.1.1/', 'Error: blocked: 192.168.1.1 resolves to non-public address 192.168.1.1'],
    ['http://169.254.169.254/latest/meta-data/', 'Error: blocked: 169.254.169.254 resolves to non-public address 169.254.169.254'],
    ['http://[::1]/', 'Error: blocked: ::1 resolves to non-public address ::1'],
    ['HTTP://127.0.0.1/', 'Error: blocked: 127.0.0.1 resolves to non-public address 127.0.0.1'],
    ['  http://127.0.0.1/', 'Error: blocked: 127.0.0.1 resolves to non-public address 127.0.0.1'],
    ['http://12\t7.0.0.1/', 'Error: blocked: 127.0.0.1 resolves to non-public address 127.0.0.1'],
    ['\x00\x01http://10.0.0.1/', 'Error: blocked: 10.0.0.1 resolves to non-public address 10.0.0.1'],
    ['http:127.0.0.1', 'Error: blocked: 127.0.0.1 resolves to non-public address 127.0.0.1'],
    ['http://user:pw@10.0.0.1:8080/x', 'Error: blocked: 10.0.0.1 resolves to non-public address 10.0.0.1'],
    ['http://100.64.0.1/', 'Error: blocked: 100.64.0.1 resolves to non-public address 100.64.0.1'],
    ['http://8.8.8.8/', undefined],
    ['HtTpS://8.8.8.8/a', undefined],
    ['https://[2606:4700::1111]/', undefined],
    ['http://224.0.0.1/', undefined],
  ])('%j', async (url, text) => {
    expect(await blocked(url)).toBe(text);
  });

  it('resolves a name and requires every address to be public, naming the first offender', async () => {
    const resolve = dns({ 'example.com': ['93.184.216.34', '2606:2800:220:1::1'], 'mixed.test': ['8.8.8.8', '10.1.2.3', '127.0.0.1'], localhost: ['::1', '127.0.0.1'] });
    expect(await blocked('https://example.com/path?q=1', resolve)).toBeUndefined();
    expect(await blocked('http://mixed.test/', resolve)).toBe('Error: blocked: mixed.test resolves to non-public address 10.1.2.3');
    expect(await blocked('http://localhost/admin', resolve)).toBe('Error: blocked: localhost resolves to non-public address ::1');
    expect(await blocked('http://nowhere.invalid/', resolve)).toBe('Error: blocked: cannot resolve nowhere.invalid: getaddrinfo ENOTFOUND nowhere.invalid');
  });

  // the guard checks the host Chromium will actually connect to
  it('checks the WHATWG host', async () => {
    expect(await blocked('http://127.0.0.1\\@evil.com/', dns({ 'evil.com': ['8.8.8.8'] }))).toBe('Error: blocked: 127.0.0.1 resolves to non-public address 127.0.0.1');
    expect(await blocked('http://0x7f.1/')).toBe('Error: blocked: 127.0.0.1 resolves to non-public address 127.0.0.1');
    expect(await blocked('http://2130706433/')).toBe('Error: blocked: 127.0.0.1 resolves to non-public address 127.0.0.1');
    const resolve = dns({ 'xn--bcher-kva.example': ['8.8.8.8'] });
    expect(await blocked('http://Bücher.example/', resolve)).toBeUndefined();
    expect(resolve.asked).toEqual(['xn--bcher-kva.example']);
  });
});

describe('isGlobal', () => {
  // per the IANA special-purpose address registries
  const VERDICTS: Record<string, boolean> = {
    '0.0.0.0': false, '0.1.2.3': false, '10.0.0.1': false, '100.63.255.255': true, '100.64.0.1': false, '100.127.255.255': false,
    '100.128.0.0': true, '127.0.0.1': false, '127.255.255.255': false, '169.254.169.254': false, '172.15.255.255': true, '172.16.0.1': false,
    '172.31.255.255': false, '172.32.0.0': true, '192.0.0.1': false, '192.0.0.8': false, '192.0.0.9': true, '192.0.0.10': true,
    '192.0.0.11': false, '192.0.0.170': false, '192.0.0.171': false, '192.0.0.255': false, '192.0.1.0': true, '192.0.2.1': false,
    '192.88.99.1': true, '192.168.1.1': false, '198.17.255.255': true, '198.18.0.1': false, '198.19.255.255': false, '198.20.0.0': true,
    '198.51.100.7': false, '203.0.113.9': false, '224.0.0.1': true, '239.255.255.255': true, '240.0.0.1': false, '255.255.255.255': false,
    '8.8.8.8': true, '93.184.216.34': true, '::': false, '::1': false, '::2': true, '::ffff:127.0.0.1': false, '::ffff:8.8.8.8': true,
    '::ffff:10.0.0.1': false, '::ffff:192.0.0.9': true, '64:ff9b::7f00:1': true, '64:ff9b:1::1': false, '100::1': false,
    '100:0:0:1::1': true, '2001::1': false, '2001:1::1': true, '2001:1::2': true, '2001:1::3': false, '2001:2::1': false,
    '2001:3::1': true, '2001:4:112::1': true, '2001:4:113::1': false, '2001:10::1': false, '2001:20::1': true, '2001:2f::1': true,
    '2001:30::1': true, '2001:3f::1': true, '2001:40::1': false, '2001:1ff::1': false, '2001:200::1': true, '2001:db8::1': false,
    '2002::1': false, '2002:7f00:1::': false, '3fff::1': false, '3fff:fff::1': false, '3fff:1000::1': true, '2606:4700::1111': true,
    'fc00::1': false, 'fd12:3456::1': false, 'fe80::1': false, 'febf::1': false, 'fec0::1': true, 'ff02::1': true, 'ff00::1': true,
    '2400:cb00::1': true, '::127.0.0.1': true,
  };

  it.each(Object.entries(VERDICTS))('%s → %s', (ip, global) => {
    expect(isGlobal(ip)).toBe(global);
  });

  it('ignores brackets (Chromium reports [::1]) and a zone suffix, and never calls a non-address public', () => {
    expect(isGlobal('[::1]')).toBe(false);
    expect(isGlobal('fe80::1%en0')).toBe(false);
    expect(isGlobal('[2606:4700::1111]')).toBe(true);
    expect(isGlobal('')).toBe(false);
    expect(isGlobal('example.com')).toBe(false);
  });
});
