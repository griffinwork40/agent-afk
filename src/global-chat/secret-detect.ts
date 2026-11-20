export type SecretKind = 'anthropic' | 'openai' | 'github' | 'slack' | 'aws'
  | 'google' | 'stripe' | 'npm' | 'telegram' | 'private_key' | 'jwt' | 'bearer';
export interface SecretSpan { kind: SecretKind; start: number; end: number }

// Specific formats precede overlapping formats. No entropy or generic length heuristic.
const PATTERNS: readonly [SecretKind, RegExp][] = [
  ['anthropic', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai', /\bsk-proj-[A-Za-z0-9_-]{20,}|\bsk-(?!ant-|proj-)[A-Za-z0-9_-]{20,}/g],
  ['github', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ['slack', /\bxox[bpars]-[A-Za-z0-9-]{20,}/g],
  ['aws', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['google', /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g],
  ['stripe', /\b[rs]k_live_[A-Za-z0-9]{16,}/g],
  ['npm', /\bnpm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g],
  ['telegram', /\b[0-9]+:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g],
  ['private_key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g],
  ['bearer', /\bBearer[ \t]+[A-Za-z0-9._~+\/-]{20,}=*/gi],
];

/** Non-overlapping spans, sorted by UTF-16 offset; full enclosing credentials win. */
export function detectSecrets(text: string): SecretSpan[] {
  const matches: SecretSpan[] = [];
  for (const [kind, pattern] of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      matches.push({ kind, start: match.index, end: match.index + match[0].length });
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const spans: SecretSpan[] = [];
  for (const match of matches) {
    if (match.start >= (spans.at(-1)?.end ?? 0)) spans.push(match);
  }
  return spans;
}
