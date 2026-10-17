import { describe, expect, it } from 'vitest';

import { CONTROL_ACTION_SCHEMA } from '../../src/claude/schema.ts';
import { loadGolden } from '../golden/load.ts';

describe('control action schema', () => {
  it('serialises to the pinned --json-schema value', () => {
    expect(JSON.stringify(CONTROL_ACTION_SCHEMA)).toBe(loadGolden<{ schema_json: string }>('argv.json').schema_json);
  });
});
