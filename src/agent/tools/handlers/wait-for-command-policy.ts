import { classifyRisk } from '../../risk-classifier.js';
import { tokenizeSegments } from '../readonly-bash.tokenizer.js';
import { classifyBashCommand } from '../readonly-bash.js';
import { hasUnquotedBackgroundOp, pollArgvReason } from './wait-for-poll-allowlist.js';

// Invariant: this supplement belongs ONLY to wait_for. The bash tool's risk
// tables and approval policy must not change when a polling builtin is added.
const READ_ONLY = new Set([
  'test', '[', 'true', 'false', 'ls', 'cat', 'stat', 'grep', 'head', 'tail',
  'wc', 'pwd', 'readlink',
]);

/**
 * Token-aware mutation guard applied to EVERY wait_for command, including ones
 * the risk table already calls 'safe' (it rates `curl -I url -X "POST"` safe).
 */
export function pollMutationReason(command: string): string | undefined {
  const mutation = classifyBashCommand(command);
  return mutation.mutating ? mutation.reason ?? 'mutating command' : undefined;
}

/** Reject syntax that can hide execution or writes before consulting safe rules. */
export function pollSyntaxReason(command: string): string | undefined {
  // Deliberately conservative even inside quotes: this is not a shell parser.
  // Refusing expansions also avoids the tokenizer's loss of quote provenance.
  if (/[$`\\]/.test(command)) return 'shell expansion, substitution or escaping is not supported';
  if (/[<>]/.test(command)) return 'shell redirection is not allowed';
  if (/[(){}\n\r]/.test(command)) return 'compound shell syntax is not supported';
  if (/(?:^|\s)#/.test(command)) return 'shell comments are not supported';
  // Reuse the existing token-aware mutation guard for quoted curl methods and
  // write-capable flags; the UI risk table alone is intentionally heuristic.
  return pollMutationReason(command);
}

/** Small, fail-closed addition to the existing risk classifier, not a shell interpreter. */
export function isReadOnlyPoll(command: string, cwd: string): boolean {
  const segments = tokenizeSegments(command);
  if (segments.length === 0) return false;
  return segments.every((tokens) => {
    const name = tokens[0];
    if (name === undefined) return false;
    if (READ_ONLY.has(name)) return name !== '[' || tokens.at(-1) === ']';
    // Reuse existing gh/git/curl reads, including in mixed builtin pipelines.
    // Quote each token so a data argument cannot become shell syntax on reparse.
    const quoted = tokens.map((token) => `'${token.replaceAll("'", "'\\''")}'`).join(' ');
    return classifyRisk('bash', { command: quoted }, { cwd }) === 'safe';
  });
}

/**
 * Single refusal gate for wait_for: undefined means the command may execute.
 *
 * Invariant: order is background `&` → syntax/mutation → per-command argv.
 * The argv check runs for classifier-`safe` commands too, because the risk
 * classifier matches leading words only and is not proof of non-mutation
 * (`git diff --output=f` and `find . -fprint f` rate `safe`). The character
 * syntax gate still applies only to the medium-risk supplement so #2750's
 * quoted `--jq` filters keep working.
 */
export function pollRefusalReason(command: string, risk: string, cwd: string): string | undefined {
  if (hasUnquotedBackgroundOp(command)) return 'background operator (&) is not allowed; use && to chain';
  if (risk !== 'safe' && risk !== 'medium') return 'command is not on the read-only polling allowlist';
  const reason = (risk === 'medium' ? pollSyntaxReason(command) : pollMutationReason(command))
    ?? pollArgvReason(command);
  if (reason !== undefined) return reason;
  return risk === 'medium' && !isReadOnlyPoll(command, cwd)
    ? 'command is not on the read-only polling allowlist'
    : undefined;
}
