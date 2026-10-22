/**
 * Command-word families for bash tool-lane rows: which colour a command word
 * gets once tool-lane-format-bash.ts has found it.
 *
 *   - `danger`  — the risk classifier rates the word's command segment `high`
 *                 (`rm`, `sudo`, `git push --force`, `curl -X POST`,
 *                 `curl … | bash`, …), or the word is in a small floor set
 *                 of verbs that are dangerous even without arguments.
 *   - `network` — a fixed list of verbs that talk to other machines.
 *   - `default` — everything else; stays the plain `toolVerb` white so the
 *                 colours keep their meaning by staying rare.
 *
 * Contract: display only. `danger` reuses `classifyRiskDetailed` so the lane
 * and the AFK gate agree on what is high risk, but nothing here gates or
 * changes behaviour. Two deliberate differences from the gate, both chosen to
 * cut display noise rather than to make anything safer:
 *   - classification is per command SEGMENT (the word up to the next unquoted
 *     separator), so in `cat x && rm -rf y` only `rm` is coloured;
 *   - quoted strings that contain whitespace (prose such as commit messages)
 *     are blanked before classifying, so `git commit -m "rm old files"` does
 *     not paint `git`. Verbs that EXECUTE their payload (`bash -c "…"`,
 *     `eval`, `ssh host "…"`) are exempt and classified on the raw text.
 *
 * @module cli/commands/interactive/tool-lane-format-bash-family
 */

import { classifyRiskDetailed, type RiskContext } from '../../../agent/risk-classifier.js';
import type { Span } from './tool-lane-format-bash.js';

export type VerbFamily = 'default' | 'network' | 'danger';

/** Verbs that reach other machines. Matched on the word's basename. */
const NETWORK_VERBS = new Set([
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'gh', 'http', 'https', 'nc', 'ncat', 'telnet', 'ftp',
]);

/**
 * Floor for verbs the classifier's substring patterns only catch with
 * arguments (`'rm '`, `'eval '`): a bare or truncated `rm` must still read
 * as dangerous.
 */
const DANGER_VERBS = new Set(['rm', 'dd', 'mkfs', 'shred', 'sudo', 'eval']);

/** Verbs whose quoted arguments are executed, so quotes are never blanked. */
const PAYLOAD_VERBS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'eval', 'ssh', 'su']);

/** The bash rules read no path context; `cwd` is required by the type only. */
const BASH_RULES_CONTEXT: RiskContext = { cwd: '' };

/** Quoted strings, single or double (with backslash escapes). */
const QUOTED_RE = /'[^']*'|"(?:[^"\\]|\\.)*"/g;

/**
 * Bounded memo of segment → high-risk verdict. Grouped rows restyle on every
 * scrollback flush; the classifier runs a tokenizer, so each distinct segment
 * is judged once. Cleared wholesale at the cap: a cold miss only costs one
 * classifier call.
 */
const highRiskMemo = new Map<string, boolean>();
const MEMO_MAX = 512;

function isHighRisk(segment: string): boolean {
  const hit = highRiskMemo.get(segment);
  if (hit !== undefined) return hit;
  const high = classifyRiskDetailed('bash', { command: segment }, BASH_RULES_CONTEXT).level === 'high';
  if (highRiskMemo.size >= MEMO_MAX) highRiskMemo.clear();
  highRiskMemo.set(segment, high);
  return high;
}

function blankProse(segment: string): string {
  return segment.replace(QUOTED_RE, (q) => (/\s/.test(q) ? q[0]! + q[0]! : q));
}

/** Family of the command word `span` within the plain (escape-free) command. */
export function verbFamily(plain: string, span: Span): VerbFamily {
  const word = plain.slice(span.start, span.end);
  const verb = word.split('/').pop() ?? word;
  if (DANGER_VERBS.has(verb)) return 'danger';
  const raw = plain.slice(span.start, span.segmentEnd).trim();
  const body = PAYLOAD_VERBS.has(verb) ? raw : blankProse(raw);
  // `| ` restores the pipe the lexer split on, so `curl x | bash` is judged
  // as `| bash` (a BASH_HIGH pattern) instead of a bare, medium `bash`.
  if (isHighRisk(span.afterPipe ? `| ${body}` : body)) return 'danger';
  return NETWORK_VERBS.has(verb) ? 'network' : 'default';
}
