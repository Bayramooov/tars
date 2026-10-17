/** Placeholder that replaces every redacted credential. */
const REDACTION = '[REDACTED]';

// Unicode-aware word boundaries: a Cyrillic letter is a word character
// (JS's `\b` would see a boundary there).
const W = String.raw`[\p{L}\p{N}_]`;
const B = String.raw`(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

const PATTERNS = [
  // Authorization / API-key headers and assignments, quoted JSON keys included
  String.raw`(?:${B})(authorization|api[-_ ]?key|x[-_]api[-_]key)["']?\s*[:=]\s*["']?((?:bearer|basic|token)\s+)?[A-Za-z0-9._\-+/=]{16,}["']?`,
  // sk-… keys (OpenAI, Anthropic, many vendors)
  String.raw`${B}sk-[A-Za-z0-9_\-]{20,}`,
  // GitHub tokens, classic and fine-grained
  String.raw`${B}gh[pousr]_[A-Za-z0-9]{36,}${B}`,
  String.raw`${B}github_pat_[A-Za-z0-9_]{22,}${B}`,
  // AWS access key id
  String.raw`${B}AKIA[0-9A-Z]{16}${B}`,
  // Slack tokens
  String.raw`${B}xox[baprs]-[A-Za-z0-9\-]+${B}`,
  // Telegram bot tokens; the lookahead needs a letter so chat:message id pairs never match
  String.raw`${B}\p{Nd}{6,12}:(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{30,40}${B}`,
  // JWTs
  String.raw`${B}eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+${B}`,
  // PEM private-key blocks
  String.raw`-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA |)PRIVATE KEY-----(?:[^-]|-(?!----))*?-----END (?:RSA |EC |OPENSSH |PGP |DSA |)PRIVATE KEY-----`,
  // DSNs with an embedded password
  String.raw`${B}(postgres|postgresql|mysql|mariadb|mongodb|mongodb\+srv|redis|amqp|amqps|rediss|ftp|ftps|sftp|ssh|smb|ldap|ldaps)://[^\s:/@]+:[^\s:/@]+@[^\s]+`,
].map((source, i) => new RegExp(source, i === 0 ? 'giu' : 'gu'));

/** Redact credential-shaped substrings before text reaches storage. */
export function scrub(text: string): string {
  return PATTERNS.reduce((out, pattern) => out.replace(pattern, REDACTION), text);
}

/** True when `scrub` would change `text`. */
export const containsSecret = (text: string) => PATTERNS.some((pattern) => new RegExp(pattern).test(text));
