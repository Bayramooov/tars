import { describe, expect, it } from 'vitest';

import { decodeDataUri } from '../../../src/tools/browser/datauri.ts';

const decoded = (url: string) => {
  try {
    return decodeDataUri(url).toString('hex');
  } catch (err) {
    return `${(err as Error).name}: ${(err as Error).message}`;
  }
};

describe('decodeDataUri', () => {
  // base64 decodes leniently: padding is optional, whitespace and stray characters are skipped
  it.each([
    ['data:text/plain;base64,SGk=', '4869'],
    ['data:,hello%20world', '68656c6c6f20776f726c64'],
    ['data:text/plain;base64,SGk', '4869'],
    ['data:;base64,SG k=', '4869'],
    ['data:;base64,SGk*=', '4869'],
    ['data:;base64,', ''],
    ['data:,', ''],
    ['data:nocomma', 'Error: malformed data: URI (no comma)'],
    ['data:,%zz%4%41%E2%82%AC€', '257a7a253441e282ace282ac'],
    ['data:;BASE64,SGk=', '53476b3d'],
    ['data:;base64,SGVsbG8gV29ybGQ', '48656c6c6f20576f726c64'],
    ['data:;base64,SGVsbG8gV29ybGQ=', '48656c6c6f20576f726c64'],
    ['data:;base64,Zm9v\nYmFy', '666f6f626172'],
    ['data:;base64,====', ''],
    ['data:;base64,SGk===', '4869'],
    ['data:;base64,SGkxSGk=', '4869314869'],
    ['data:;base64,SGkxSG==', '48693148'],
  ])('%j', (url, expected) => {
    expect(decoded(url)).toBe(expected);
  });
});
