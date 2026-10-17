import { describe, expect, it } from 'vitest';

import { classifyFailure, failureMessage } from '../../src/claude/failures.ts';

describe('failure classifier', () => {
  it('recognises model, auth, quota and rate-limit failures, case-insensitively', () => {
    expect(classifyFailure(['There is an issue with the selected model (claude-sonet-4)'])?.kind).toBe('model-access');
    expect(classifyFailure(['Invalid API key · Please run /login'])?.kind).toBe('auth');
    // Claude Code 2.1.263's wording when the OAuth login lapses.
    expect(classifyFailure(['Failed to authenticate: OAuth session expired and could not be refreshed'])?.kind).toBe('auth');
    expect(classifyFailure(['Credits exhausted for this org'])?.kind).toBe('quota');
    expect(classifyFailure(['429 Too Many Requests'])?.kind).toBe('rate-limit');
    expect(classifyFailure(['all good', ''])).toBeUndefined();
  });

  it('takes the first source that matches and cuts it to 400 characters', () => {
    const failure = classifyFailure([undefined, 'harmless', `  rate limit ${'x'.repeat(500)}  `, 'quota']);
    expect(failure?.kind).toBe('rate-limit');
    expect(failure?.matchedSource).toBe(`rate limit ${'x'.repeat(389)}…`);
  });

  it('formats the owner alert', () => {
    const failure = classifyFailure(['usage limit reached']);
    expect(failure && failureMessage(failure)).toBe('⚠️ Claude API quota/credits exhausted. The operator needs to top up or wait for the quota to reset.\n\nDetails:\nusage limit reached');
  });
});
