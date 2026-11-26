// Contract: secondary predicate for plain `rm` commands (#5292).
//
// The plain 'rm ' entry in BASH_HIGH catches every `rm` invocation, but gate
// precision audit (2026-11-23) found 0% true-positive precision across 21
// observed blocks -- all were routine temp/scratch/cache-file cleanup in
// autonomous daemon tasks.  This module adds a refinement step: after the
// 'rm ' BASH_HIGH token fires, classifyRmRisk() inspects the full command
// and downgrades to 'medium' when the arguments target only declared-ephemeral
// locations and no structural danger flags are present.
//
// Invariant: keep at HIGH when ANY of the following is true:
//   1. A recursive flag is present (-r, -R, --recursive, or any long-option
//      prefix abbreviation such as --rec, --recur, --recurs, --recursiv).
//   2. A glob character (*, ?, [, {) appears in an argument that does NOT
//      resolve to a declared-ephemeral namespace.
//   3. An absolute path that is not under /tmp or /var/tmp is targeted.
//   4. Any argument contains a shell expansion marker ($, backtick, or ~ prefix).
//   5. The command contains a shell separator (;, |, &, newline) — i.e. it is
//      a compound command. No wrapper enumeration: the wrapper namespace is
//      unbounded (env -i, command, doas, PATH-shadowed binaries …), so the
//      only safe rule is: separator present → HIGH, always.
//   6. Any relative argument escapes its declared-ephemeral namespace via path
//      traversal (.scratch/../secrets.txt must NOT be considered ephemeral).
//
// Declared-ephemeral namespaces (glob-safe targets):
//   /tmp/...           OS temp dir
//   /var/tmp/...       OS temp dir, persists across reboots but still ephemeral
//   .scratch/...       agent scratch convention
//   <dir>/_raw/...     pipeline raw-input artifacts
//   <dir>/.cache/...   .cache/ dirs (dotfile convention only)
//   *.tmp              explicit .tmp extension
//   *._raw             explicit ._raw extension
//   Named temp-file conventions used in daemon tasks (from sampled FPs):
//     .brief-out.tmp, .brief-err.tmp, .prs-*.json, .forecast-queue entries
//
// 'rm -rf' (index 0 in BASH_HIGH) is matched before 'rm ' (index 1) and is
// never passed to this function -- it stays unconditionally HIGH.
//
// @module agent/risk-classifier.rm-predicate

import path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flags that make any rm invocation unconditionally high-risk. */
const RECURSIVE_FLAGS = new Set(['-r', '-R', '--recursive']);

// Long-option prefix abbreviations for --recursive that GNU rm accepts via
// getopt_long prefix matching. GNU getopt_long accepts any unambiguous prefix
// of a long option name, so --r, --re, --rec, --recu, --recur, --recurs, and
// --recursiv all expand to --recursive. We conservatively block the entire
// --r* through --recursiv namespace (up to but not including the full word
// '--recursive', which is in RECURSIVE_FLAGS). The pattern is anchored at both
// ends so '--remove' or '--reset' (which diverge at '--rem', '--res') are not
// caught; only the exact prefixes of 'recursive' from length 1 onward match.
const RECURSIVE_LONG_PREFIX = /^--r(?:e(?:c(?:u(?:r(?:s(?:i(?:v)?)?)?)?)?)?)?$/;

// Glob characters that signal a wildcard expansion. Present in an argument
// outside a declared-ephemeral namespace -> keep HIGH.
const GLOB_CHARS = /[*?[{]/;

// Declared-ephemeral path prefixes (checked against each argument).
// Matching is performed on the raw argument string so that partial path
// segments (e.g. "cache/" embedded in an absolute path) do not give a false
// ephemeral hit. More-specific patterns listed first to shadow /tmp when both
// could match.
const EPHEMERAL_PREFIXES: readonly string[] = [
  '/tmp/',
  '/var/tmp/',
];

// Pattern segments that mark an argument as ephemeral regardless of prefix.
// Each is tested against the FULL argument string.
// Individual absolute paths under /tmp are covered by EPHEMERAL_PREFIXES
// above; these patterns handle relative-path conventions used in daemon tasks.
const EPHEMERAL_PATTERNS: readonly RegExp[] = [
  /^\.scratch\//,              // .scratch/ prefix
  /(?:^|\/)_raw\//,            // <dir>/_raw/ pipeline artifacts (leading or mid-path)
  /(?:^|\/)\.cache\//,          // .cache/ dirs (dotfile convention only)
  /\.tmp$/,                    // *.tmp extension
  /\._raw$/,                   // *._raw extension
  // Named temp-file conventions used in daemon tasks (from sampled FPs):
  // Matches: .brief-out.tmp  .brief-err.tmp  .brief-out.txt  .brief-err.txt
  /^\.brief-(?:out|err)\.(?:tmp|txt)$/,
  /^\.prs-[^/]*\.json$/,       // .prs-*.json stale cache files
  /^\.forecast-[^/]*/,         // .forecast-queue artifacts
];

/**
 * True when `arg` (relative) contains any `..` path segment.
 *
 * We conservatively reject ALL relative paths that contain a `..` component,
 * regardless of whether the traversal appears to stay within an ephemeral
 * namespace after normalization. Per-pattern analysis is not used here because
 * it has two known bypass classes:
 *
 *   1. Cross-namespace traversal: `.cache/../other/.cache/a` normalizes to
 *      `other/.cache/a`, which still matches the `.cache/` pattern — the
 *      namespace was escaped and re-entered, but the pattern check passes.
 *
 *   2. Extension escape: `.cache/../secret.tmp` — the `.tmp` extension
 *      pattern matches BOTH the original AND the normalized `secret.tmp`,
 *      so the per-pattern loop sees no escape and returns false.
 *
 * The only safe rule is: a relative path with ANY `..` segment is HIGH.
 * Legitimate ephemeral cleanup never needs `..`; daemon tasks operate on
 * paths they construct directly under known prefixes.
 *
 * This is checked as a gate BEFORE isEphemeral so that a traversing path is
 * never downgraded to medium regardless of whether the traversal target looks
 * ephemeral.
 */
function hasRelativeTraversal(arg: string): boolean {
  // Only applies to relative paths (absolute are handled by isNonEphemeralAbsolute).
  if (arg.startsWith('/')) return false;
  // Reject any relative path containing a .. segment unconditionally.
  // Split on '/' and test each segment so that partial matches like '..foo'
  // or 'foo..' are not caught — only the exact segment '..' triggers HIGH.
  return arg.split('/').some(seg => seg === '..');
}

// True when `arg` resolves to a declared-ephemeral location.
// Called only on non-flag argument tokens that have already passed the
// traversal guard (hasRelativeTraversal).
function isEphemeral(arg: string): boolean {
  const normalizedArg = arg.startsWith('/') ? path.posix.normalize(arg) : arg;
  for (const prefix of EPHEMERAL_PREFIXES) {
    if (normalizedArg.startsWith(prefix)) return true;
  }
  for (const pattern of EPHEMERAL_PATTERNS) {
    if (pattern.test(arg)) return true;
  }
  return false;
}

// True when `arg` is an absolute path that is NOT under a known-ephemeral
// prefix (/tmp/, /var/tmp/). Absolute paths outside these namespaces are
// unconditionally HIGH regardless of other rules.
function isNonEphemeralAbsolute(arg: string): boolean {
  if (!arg.startsWith('/')) return false;
  const normalized = path.posix.normalize(arg);
  for (const prefix of EPHEMERAL_PREFIXES) {
    if (normalized.startsWith(prefix)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

// Split the portion of `cmd` after the `rm` token into individual shell-like
// tokens. This is NOT a full shell parser: it splits on whitespace and strips
// simple single/double-quoted strings (removing the quote characters). It is
// deliberately conservative -- ambiguous quoting keeps the HIGH verdict.
//
// Conservative rejection policy (both cases return [] → caller returns HIGH):
//
//   Shell escape sequences (backslash in an unquoted token):
//     A backslash in an unquoted token is a shell escape character. The shell
//     resolves the escape before executing rm, producing a path that the
//     tokenizer cannot see. For example `.scratch/.\./secrets.txt` is passed
//     to rm as `.scratch/././secrets.txt` (backslash-dot collapses to dot),
//     so hasRelativeTraversal (which checks for the literal `..` segment) would
//     not fire. Rather than partially parse escape sequences we cannot fully
//     resolve, we return [] for any unquoted token containing a backslash.
//
//   Embedded quotes inside a token (mixed quoting / splice):
//     The shell splices quoted and unquoted segments of a word before passing
//     the argument to rm. `--recur"sive"` is therefore exactly `--recursive`
//     at execution time — a recursive flag — but the tokenizer sees the literal
//     bytes `--recur"sive"` which match neither RECURSIVE_FLAGS nor
//     RECURSIVE_LONG_PREFIX. Rather than implement splice-aware shell quoting
//     we return [] for any token that starts unquoted and encounters a quote
//     character mid-token, or for any whole-token quoted string whose closing
//     quote is immediately followed by a non-whitespace/non-meta character
//     (adjacent splice: `"--recur"sive`).
//
//     Safe whole-token quoted args (opening quote → content → closing quote →
//     whitespace/meta/end) are still allowed: e.g. `'.scratch/file.txt'` and
//     `"/tmp/stale.json"` produce clean tokens.
//
// Returns an empty array when the rm token is not found (should not happen in
// practice since the caller verified the BASH_HIGH match).
function tokenizeRmArgs(cmd: string): string[] {
  // Find the rm token boundary (word-start guaranteed by findHighBashPattern).
  const match = /(?:^|[\s;|&(])(?:[gsGS])?[Rr][Mm]([\s$'"\\;|]|$)/.exec(cmd);
  if (match === null) return [];
  // Advance past `rm` and its trailing separator character.
  const startIdx = (match.index ?? 0) + match[0].length - (match[1]?.length ?? 0);
  const rest = cmd.slice(startIdx);

  // Tokenise on whitespace; collapse quoted strings to their content.
  const tokens: string[] = [];
  let i = 0;
  while (i < rest.length) {
    // Skip whitespace
    while (i < rest.length && /\s/.test(rest[i]!)) i++;
    if (i >= rest.length) break;

    // Shell meta characters that end the rm argument list
    const ch = rest[i]!;
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(') break;

    if (ch === "'" || ch === '"') {
      // Whole-token quoted string: collect until matching close quote.
      const quote = ch;
      i++;
      let content = '';
      while (i < rest.length && rest[i] !== quote) {
        content += rest[i];
        i++;
      }
      i++; // skip closing quote
      // Embedded-quote / splice guard: if the character immediately after the
      // closing quote is non-whitespace and non-meta (e.g. `"--recur"sive`),
      // this is a shell splice we cannot safely resolve — return [] → HIGH.
      if (i < rest.length && !/[\s;|&(]/.test(rest[i]!)) return [];
      tokens.push(content);
    } else {
      // Unquoted token: collect until whitespace or meta.
      let token = '';
      while (i < rest.length && !/[\s;|&(]/.test(rest[i]!)) {
        const c = rest[i]!;
        // Shell escape guard: backslash in an unquoted token cannot be
        // resolved without shell semantics — return [] → HIGH.
        if (c === '\\') return [];
        // Embedded-quote / splice guard: a quote character mid-unquoted-token
        // (e.g. `--recur"sive"`) starts a splice we cannot safely resolve —
        // return [] → HIGH.
        if (c === "'" || c === '"') return [];
        token += c;
        i++;
      }
      tokens.push(token);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Returns true when `cmd` contains a shell separator (;, |, &, or newline).
//
// Any compound command is rejected unconditionally. Enumerating known wrappers
// (env, exec, command, env -i, …) is not sufficient: the wrapper namespace is
// open-ended and any unlisted form (e.g. `env -i /bin/rm`, `command /bin/rm`,
// a future `doas`, a PATH-shadowed binary) would bypass an allowlist.
//
// Conservative policy: a compound rm command is never safe to downgrade to
// medium, even when the second segment looks innocuous (e.g. `; echo done`).
// Legitimate daemon temp-file cleanup is always a single standalone rm
// invocation; no real workflow requires chaining rm with another command.
function hasShellSeparator(cmd: string): boolean {
  return /[;|&\n]/.test(cmd);
}

/**
 * Secondary predicate for plain `rm` commands. Called only after the 'rm '
 * BASH_HIGH token fires (not after 'rm -rf' -- that stays unconditional).
 *
 * Returns 'high' when any structural danger is present; 'medium' otherwise
 * (plain temp-file cleanup, safe for daemon auto-allow).
 *
 * Invariant: this function never returns 'safe' -- a plain rm on a named
 * file is always at least medium risk.
 */
export function classifyRmRisk(cmd: string): 'high' | 'medium' {
  // Guard: if `rm` appears as a subcommand of another program (e.g.
  // `docker rm`, `podman rm`) the arguments are container/object IDs, not
  // file paths. Keep HIGH so the predicate never downgrades such invocations.
  //
  // Detection: scan the token that immediately precedes the `rm` match in the
  // command string. If that token is a plain word (not starting with `-` and
  // not a shell separator), `rm` is a subcommand argument -- return HIGH.
  // "Plain word before rm" means: after any leading whitespace, work backward
  // from the character before the space that precedes `rm` and extract the
  // last whitespace-delimited token. If it looks like a command name (alpha-
  // numeric, no `-` prefix) then rm is a subcommand.
  //
  // Invariant: flags (tokens starting with -) before `rm` do NOT make it a
  // subcommand -- `docker --force rm` has `--force` preceding `rm`, but `rm`
  // is still the docker subcommand verb. We must look past leading flags to
  // find the actual program name. We scan backward through whitespace-
  // separated tokens, skipping flag tokens (starting with -), and check the
  // first non-flag token. If it is a plain word (non-empty, not starting with
  // `-`), rm is a subcommand.
  const rmMatch = /(?:[gsGS])?[Rr][Mm](?=[\s$'"\\;|]|$)/.exec(cmd);
  if (rmMatch !== null) {
    // Extract the portion of the command before the rm token.
    const before = cmd.slice(0, rmMatch.index).trimEnd();
    if (before.length > 0) {
      // Split into tokens on whitespace/separators and scan backward for the
      // first non-flag token (skip tokens starting with -).
      const beforeTokens = before.split(/[\s;|&(]+/);
      for (let i = beforeTokens.length - 1; i >= 0; i--) {
        const tok = beforeTokens[i] ?? '';
        if (tok.length === 0) continue;
        if (tok.startsWith('-')) continue; // skip flag tokens
        // Found the first non-flag token before rm -- if it looks like a
        // command name, rm is a subcommand.
        if (!tok.startsWith('/') && !tok.includes('=')) return 'high';
        // A path-prefixed command (e.g. /usr/bin/docker) also qualifies.
        if (tok.startsWith('/')) return 'high';
        break;
      }
    }
  }

  const args = tokenizeRmArgs(cmd);

  // No arguments parsed -> conservative HIGH (can't inspect).
  if (args.length === 0) return 'high';

  // Item 5: compound command (shell separator present) -> HIGH.
  //
  // Any separator (;, |, &, newline) makes the command compound. We reject
  // ALL compound rm commands unconditionally rather than enumerating wrappers.
  // Rationale: the wrapper namespace is unbounded — `env -i /bin/rm`,
  // `command /bin/rm`, `doas rm`, PATH-shadowed binaries, etc. cannot all be
  // listed. The only safe policy is: compound command → HIGH, always.
  //
  // This is checked early, before the argument loop, so that a compound
  // command like `rm /tmp/a; env -i /bin/rm -r /etc` does not get incorrectly
  // downgraded because the first rm segment's arguments are ephemeral.
  if (hasShellSeparator(cmd)) return 'high';

  // Item 4: shell expansion markers -> HIGH (value unknown at classify time).
  // $VAR, `cmd`, ~/ or bare ~ all expand to paths we cannot inspect safely.
  for (const arg of args) {
    if (arg.includes('$')) return 'high';
    if (arg.includes('`')) return 'high';
    if (arg === '~' || arg.startsWith('~/')) return 'high';
  }

  let hasNonFlagArg = false;

  for (const arg of args) {
    // ---- Flag handling -------------------------------------------------------
    if (arg.startsWith('-')) {
      // Recursive flags -> unconditionally HIGH.
      if (RECURSIVE_FLAGS.has(arg)) return 'high';
      // GNU long-option prefix abbreviations for --recursive (e.g. --rec,
      // --recu, --recur, --recurs, --recursiv). getopt_long accepts any
      // unambiguous prefix; we reject the entire --rec* namespace conservatively.
      if (RECURSIVE_LONG_PREFIX.test(arg)) return 'high';
      // Combined short flags: -rf, -fr, -rI, etc.
      if (!arg.startsWith('--')) {
        const chars = arg.slice(1);
        if (chars.includes('r') || chars.includes('R')) return 'high';
      }
      // Other flags (e.g. -f, -i, -v) are benign -- continue.
      continue;
    }

    // ---- Non-flag argument ---------------------------------------------------
    hasNonFlagArg = true;

    // Rule 6: relative path traversal that escapes its namespace -> HIGH.
    // Must be checked before isEphemeral so that .scratch/../secrets.txt
    // is never downgraded to medium.
    if (hasRelativeTraversal(arg)) return 'high';

    // Rule 3: absolute path outside /tmp or /var/tmp -> HIGH.
    if (isNonEphemeralAbsolute(arg)) return 'high';

    // Rule 2: glob character in a non-ephemeral argument -> HIGH.
    if (GLOB_CHARS.test(arg) && !isEphemeral(arg)) return 'high';

    // Rule 4: relative path containing a bare cache/ segment (not .cache/) is
    // not an ephemeral location and is not a recognized daemon convention.
    // project/cache/data is a project directory, not a system temp cache.
    if (!arg.startsWith('/') && /(?:^|\/)cache\//.test(arg)) return 'high';

    // Rule 5: relative path with no positive ephemeral match -> HIGH.
    // Only downgrade when the argument is a positively-identified ephemeral
    // target (declared prefix or pattern). Unknown relative paths like
    // "foo.txt" or "old-file.txt" stay HIGH -- we cannot prove they are safe.
    if (!arg.startsWith('/') && !isEphemeral(arg)) return 'high';
  }

  // No arguments other than flags -> HIGH (bare `rm -f` with no target is
  // suspicious; also guards against rm with only separator-evasion tricks).
  if (!hasNonFlagArg) return 'high';

  return 'medium';
}
