import { classifyRisk } from '../../risk-classifier.js';
import { tokenizeSegments } from '../readonly-bash.tokenizer.js';
import { classifyBashCommand } from '../readonly-bash.js';

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
