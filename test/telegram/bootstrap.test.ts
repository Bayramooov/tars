import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { bootstrapAccess } from '../../src/telegram/bootstrap.ts';
import { memoryLogger } from '../helpers/log.ts';
import { tempDir } from '../helpers/tmp.ts';

describe('access bootstrap', () => {
  it('creates an owner-only access.json on first boot, and reports the policy on later ones', () => {
    const path = join(tempDir(), 'access.json');
    const log = memoryLogger();
    bootstrapAccess(path, log);
    expect(readFileSync(path, 'utf8')).toBe('{\n  "policy": "owner_only",\n  "allowed_users": [],\n  "allowed_chats": []\n}\n');
    expect(log.text()).toBe(`INFO created ${path} (policy=owner_only, chats=[])`);
    writeFileSync(path, JSON.stringify({ policy: 'allowlist', allowed_users: [1, 2], allowed_chats: [-100] }));
    const again = memoryLogger();
    bootstrapAccess(path, again);
    expect(again.text()).toBe('INFO access: policy=allowlist, allowed_users=2, allowed_chats=1');
  });
});
