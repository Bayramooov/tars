import { clip } from '../text/clip.ts';

export interface FailureClass {
  kind: 'model-access' | 'auth' | 'quota' | 'rate-limit';
  /** Owner-facing explanation and the fix. */
  userMessage: string;
  /** The text that matched, stripped and cut to 400 characters. */
  matchedSource: string;
}

/** Known Claude Code failure signatures, most specific first; keywords are lowercase substrings. */
const PATTERNS: readonly { kind: FailureClass['kind']; keywords: readonly string[]; userMessage: string }[] = [
  {
    kind: 'model-access',
    keywords: ['issue with the selected model', 'model does not exist', 'model not found', 'you may not have access to it'],
    userMessage: '⚠️ The configured Claude model is unavailable. The operator needs to fix `TARS_MODEL` in the environment.',
  },
  {
    kind: 'auth',
    keywords: ['unauthorized', 'authentication failed', 'invalid api key', 'invalid_api_key', 'subscription', 'please log in', 'not logged in', 'expired credentials', 'expired token'],
    userMessage:
      '⚠️ Claude authentication failed — the token may be missing or revoked. ' +
      'The operator needs to regenerate it with `claude setup-token` and update `CLAUDE_CODE_OAUTH_TOKEN` in `.env`.',
  },
  {
    kind: 'quota',
    keywords: ['quota', 'usage limit', 'credits exhausted', 'insufficient credits'],
    userMessage: '⚠️ Claude API quota/credits exhausted. The operator needs to top up or wait for the quota to reset.',
  },
  {
    kind: 'rate-limit',
    keywords: ['rate limit', 'rate_limit', 'overloaded', 'too many requests'],
    userMessage: "⚠️ I've been rate-limited by the API. Give me a moment and try again shortly.",
  },
];

/** The first known failure any source text names (sources checked in order), if any. */
export function classifyFailure(sources: readonly (string | undefined)[]): FailureClass | undefined {
  for (const source of sources) {
    if (!source) continue;
    const haystack = source.toLowerCase();
    const pattern = PATTERNS.find((p) => p.keywords.some((kw) => haystack.includes(kw)));
    if (!pattern) continue;
    return { kind: pattern.kind, userMessage: pattern.userMessage, matchedSource: clip(source.trim(), 400) };
  }
  return undefined;
}

/** The owner alert for a classified failure: the explanation plus the matched diagnostic. */
export const failureMessage = (failure: FailureClass) => `${failure.userMessage}\n\nDetails:\n${failure.matchedSource}`;
