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
//   1. A recursive flag is present (-r, -R, --recursive).
//   2. A glob character (*, ?, [, {) appears in an argument that does NOT
//      resolve to a declared-ephemeral namespace.
//   3. An absolute path that is not under /tmp or /var/tmp is targeted.
//
// Declared-ephemeral namespaces (glob-safe targets):
//   /tmp/...           OS temp dir
//   /var/tmp/...       OS temp dir, persists across reboots but still ephemeral
//   .scratch/...       agent scratch convention
//   <dir>/_raw/...     pipeline raw-input artifacts
//   <dir>/cache/...    cache dirs
//   *.tmp              explicit .tmp extension
//   *._raw             explicit ._raw extension
//   Named temp-file conventions used in daemon tasks (from sampled FPs):
//     .brief-out.tmp, .brief-err.tmp, .prs-*.json, .forecast-queue entries
//
// 'rm -rf' (index 0 in BASH_HIGH) is matched before 'rm ' (index 1) and is
// never passed to this function -- it stays unconditionally HIGH.
//
// @module agent/risk-classifier.rm-predicate

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flags that make any rm invocation unconditionally high-risk. */
const RECURSIVE_FLAGS = new Set(['-r', '-R', '--recursive']);

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
  /(?:^|\/)\.?cache\//,        // .cache/ or cache/ dirs (leading or mid-path)
  /\.tmp$/,                    // *.tmp extension
  /\._raw$/,                   // *._raw extension
  // Named temp-file conventions used in daemon tasks (from sampled FPs):
  // Matches: .brief-out.tmp  .brief-err.tmp  .brief-out.txt  etc.
  /^\.[a-z][-a-z0-9]*[-.](?:tmp|err|out|json|txt)$/,
  /^\.prs-[^/]*\.json$/,       // .prs-*.json stale cache files
  /^\.forecast-[^/]*/,         // .forecast-queue artifacts
];

// True when `arg` resolves to a declared-ephemeral location.
// Called only on non-flag argument tokens.
function isEphemeral(arg: string): boolean {
  for (const prefix of EPHEMERAL_PREFIXES) {
    if (arg.startsWith(prefix)) return true;
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
  for (const prefix of EPHEMERAL_PREFIXES) {
    if (arg.startsWith(prefix)) return false;
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
      // Quoted string: collect until matching close quote
      const quote = ch;
      i++;
      let content = '';
      while (i < rest.length && rest[i] !== quote) {
        content += rest[i];
        i++;
      }
      i++; // skip closing quote
      tokens.push(content);
    } else {
      // Unquoted token: collect until whitespace or meta
      let token = '';
      while (i < rest.length && !/[\s;|&(]/.test(rest[i]!)) {
        token += rest[i];
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
  const rmMatch = /(?:[gsGS])?[Rr][Mm](?=[\s$'"\\;|]|$)/.exec(cmd);
  if (rmMatch !== null) {
    // Extract the portion of the command before the rm token.
    const before = cmd.slice(0, rmMatch.index).trimEnd();
    if (before.length > 0) {
      // Find the last whitespace-delimited token in `before`.
      const lastToken = before.split(/[\s;|&(]+/).pop() ?? '';
      // If the token is a plain word (not a flag, not empty), rm is a
      // subcommand -- keep HIGH.
      if (lastToken.length > 0 && !lastToken.startsWith('-')) return 'high';
    }
  }

  const args = tokenizeRmArgs(cmd);

  // No arguments parsed -> conservative HIGH (can't inspect).
  if (args.length === 0) return 'high';

  let hasNonFlagArg = false;

  for (const arg of args) {
    // ---- Flag handling -------------------------------------------------------
    if (arg.startsWith('-')) {
      // Recursive flags -> unconditionally HIGH.
      if (RECURSIVE_FLAGS.has(arg)) return 'high';
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

    // Rule 3: absolute path outside /tmp or /var/tmp -> HIGH.
    if (isNonEphemeralAbsolute(arg)) return 'high';

    // Rule 2: glob character in a non-ephemeral argument -> HIGH.
    if (GLOB_CHARS.test(arg) && !isEphemeral(arg)) return 'high';
  }

  // No arguments other than flags -> HIGH (bare `rm -f` with no target is
  // suspicious; also guards against rm with only separator-evasion tricks).
  if (!hasNonFlagArg) return 'high';

  return 'medium';
}
