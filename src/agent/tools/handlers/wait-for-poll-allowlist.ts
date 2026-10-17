/**
 * Command-specific argv checks for wait_for polling.
 *
 * Invariant: the bash risk classifier is a UI approval heuristic that matches
 * only leading words (`git diff`, `find `, `curl -I `). It is NOT proof that a
 * command does not write: it rates `git diff --output=marker`,
 * `find . -fprint out` and `curl -I url -c jar` safe. wait_for executes
 * commands unattended, so every segment of every command — classifier-safe or
 * admitted by the read-only supplement — is re-checked here:
 *
 *   - git, curl, wget: POSITIVE per-family flag allowlists (unknown flag → refuse).
 *   - find: every write/exec action primary is refused.
 *
 * Programs outside these families keep whichever gate already admitted them
 * (the read-only builtin set or the classifier's exact-word safe table).
 * This module never changes bash tool classification.
 *
 * @module agent/tools/handlers/wait-for-poll-allowlist
 */

import { tokenizeSegments } from '../readonly-bash.tokenizer.js';
import { argvAllowed, type ArgvSpec } from './wait-for-poll-allowlist.argv.js';
import { gitArgvAllowed } from './wait-for-poll-allowlist.git.js';

const set = (words: string): ReadonlySet<string> => new Set(words.trim().split(/\s+/));

/**
 * curl read-only probe flags. Deliberately absent (they write files or run
 * config): -o -O --output --output-dir -D --dump-header -c --cookie-jar
 * --trace --trace-ascii --stderr --libcurl -w --write-out (`%output{}`)
 * -K --config -T --upload-file -d --data* -F --form -X --request --etag-save
 * --hsts --alt-svc --next.
 */
const CURL: ArgvSpec = {
  flags: set(`-I --head -s --silent -S --show-error -f --fail --fail-with-body -i --include
    -L --location --max-redirs -m --max-time --connect-timeout -H --header -A --user-agent
    --compressed -k --insecure --http1.1 --http2 --retry --retry-delay --retry-max-time
    -v --verbose -4 -6 --no-progress-meter`),
  valueShorts: 'mHA',
};

/** wget spider probes only; -o/-a (log files), -O, -e (wgetrc commands) are absent. */
const WGET: ArgvSpec = {
  flags: set(`--spider -q --quiet -nv --no-verbose -S --server-response -T --timeout -t --tries
    --max-redirect --no-check-certificate --header`),
  valueShorts: 'Tt',
  requireAny: set('--spider'),
};

/** find primaries that delete, write a file, or execute a program. */
const FIND_WRITE_PRIMARY = /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;

/** `2>&1`, `>&2`, `2>/dev/null`: no file write; mirrors risk-classifier.bash-safe. */
const NEUTRAL_REDIRECT = /(?:\d|&)?>>?(?:&(?:\d+|-)|\s*\/dev\/null\b)/g;

const ASSIGNMENT = /^[A-Za-z_]\w*=/;

/**
 * Strip what the classifier's safe table already looks through — leading
 * `VAR=val` assignments and the `pnpm exec` / `npx` launchers — so
 * `X=1 git diff --output=f` and `pnpm exec git diff --output=f` are judged on git.
 */
function commandWords(tokens: readonly string[]): readonly string[] {
  let i = 0;
  while (i < tokens.length && ASSIGNMENT.test(tokens[i]!)) i++;
  if (tokens[i] === 'pnpm' && tokens[i + 1] === 'exec') i += 2;
  else if (tokens[i] === 'npx') i++;
  return tokens.slice(i);
}

/** Why one tokenized segment is refused, or undefined when its argv is read-only. */
export function segmentArgvReason(tokens: readonly string[]): string | undefined {
  const words = commandWords(tokens);
  const cmd = words[0];
  if (cmd === undefined) return undefined;
  const argv = words.slice(1);
  switch (cmd.split('/').pop()) {
    case 'git':
      return gitArgvAllowed(argv) ? undefined : 'git subcommand or flag is not on the read-only allowlist';
    case 'curl':
      return argvAllowed(argv, CURL) ? undefined : 'curl flag is not on the read-only probe allowlist';
    case 'wget':
      return argvAllowed(argv, WGET) ? undefined : 'wget is only allowed as a --spider probe';
    case 'find':
      return argv.some((t) => FIND_WRITE_PRIMARY.test(t)) ? 'find action that writes or executes' : undefined;
    default:
      return undefined;
  }
}

/** Argv check over every segment of `command` (applied to ALL wait_for commands). */
export function pollArgvReason(command: string): string | undefined {
  for (const tokens of tokenizeSegments(command.replace(NEUTRAL_REDIRECT, ' '))) {
    const reason = segmentArgvReason(tokens);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/**
 * True when `command` holds an unquoted `&` that backgrounds a job.
 *
 * Invariant: the tokenizer treats every `&` as a plain boundary, and `false &`
 * exits 0 from the async list, so wait_for would report a false success (and
 * leave a process running past the poll). `&&` and fd duplication (`>&1`,
 * `<&0`, `2>&-`) are not background operators; `&>file` and `|&` are refused
 * because /bin/sh (dash) parses them as `&` followed by a redirect/pipe.
 */
export function hasUnquotedBackgroundOp(command: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i++;
      continue;
    }
    if (ch === '\\') i++;
    else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '&') {
      if (command[i + 1] === '&') i++;
      else if (command[i - 1] !== '>' && command[i - 1] !== '<') return true;
    }
  }
  return false;
}
