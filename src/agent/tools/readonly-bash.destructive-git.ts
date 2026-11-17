// Invariant: Working-tree-destructive git classifier.
//
// Extracted from `readonly-bash.tokenizer.ts` to keep that file within the
// 350-code-line ceiling. Owns `DESTRUCTIVE_GIT_SUBCMDS`,
// `destructiveGitSegmentReason`, and `classifyDestructiveGit`. Payload
// extraction for nested commands (interpreter `-c` strings, `eval`, command
// substitution as the command name) lives in
// `readonly-bash.destructive-git.nested.ts`; recursion stays here.
//
// Limit of this gate: it classifies a COMMAND STRING. It follows the shell
// forms it can read (wrappers, variables, compound commands, pipes into a
// shell, `sh -c` / `bash -lc` strings, `eval`, substitutions, inline git
// aliases), but it cannot see inside another language's string:
// `python3 -c "os.system('git checkout main')"`, `node -e "execSync(…)"`,
// or a script file. Shell heredocs are classified; known data-consumer bodies
// are skipped, but their unquoted command substitutions are still checked.
// Ambiguous heredoc boundaries fail closed. The gate stops
// a child from wiping a working tree by habit; it does not contain a child
// that is trying to get around it.

import { destructiveGitHeredocView } from './readonly-bash.destructive-git.heredoc.js';
import {
  baseName,
  gitSubcommand,
  tokenizeSegments,
  resolveSegment,
} from './readonly-bash.tokenizer.js';
import {
  SHELL_INTERPS,
  INTERP_WRAPPERS,
  interpreterCommandStrings,
  evalPayloads,
  substitutionRewrites,
} from './readonly-bash.destructive-git.nested.js';

/**
 * git subcommands that destroy working-tree state. A subset of
 * `GIT_MUTATING_SUBCMDS` — checked by `destructiveGitSegmentReason`.
 */
export const DESTRUCTIVE_GIT_SUBCMDS = new Set([
  'checkout', 'switch', 'restore', 'clean',
]);

/** Verdict shape returned by {@link classifyDestructiveGit}. */
type Verdict = { destructive: boolean; reason?: string };

// Nested commands (`sh -c` in `eval` in `$(…)` …) are followed this many
// levels deep. Past it, any mention of git is treated as destructive: a
// legitimate command never nests this far, so failing closed costs nothing.
const MAX_NESTING = 4;

// Flags that make a branch-creating checkout/switch overwrite local changes
// or restore paths, so the `-b` / `-c` exemption must not apply.
const FORCING_FLAGS = new Set([
  '-f', '--force', '--discard-changes', '-m', '--merge', '-p', '--patch', '--',
]);

/**
 * True when `git checkout -b|-B <new> [<start>]` / `git switch -c|-C <new>
 * [<start>]` only creates a branch: no forcing / path-restoring flag and at
 * most the new name plus one start point. Anything else falls through to
 * the destructive verdict (`git switch -c x --discard-changes main`,
 * `git checkout -b x -- src/a.ts`).
 */
function isPlainBranchCreation(sub: string, rest: readonly string[]): boolean {
  const createFlags = sub === 'checkout' ? ['-b', '-B'] : ['-c', '-C'];
  if (!rest.some((t) => createFlags.includes(t))) return false;
  if (rest.some((t) => FORCING_FLAGS.has(t) || t.startsWith('--pathspec'))) return false;
  const positional = rest.filter((t) => !t.startsWith('-'));
  return positional.length <= 2;
}

/**
 * Inline aliases defined with `git -c alias.<name>=<value>` before the
 * subcommand. Returned as a name → value map (git's own global-flag order).
 */
function inlineGitAliases(argv: readonly string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] !== '-c') continue;
    const m = /^alias\.([^=]+)=(.*)$/s.exec(argv[i + 1]!);
    if (m !== null) aliases.set(m[1]!, m[2]!);
  }
  return aliases;
}

/** Plumbing and worktree forms that overwrite or delete working-tree files. */
function plumbingDestructiveReason(sub: string, rest: readonly string[]): string | null {
  const forced = rest.includes('-f') || rest.includes('--force');
  if (sub === 'read-tree' && rest.includes('-u')) return 'git read-tree -u (working-tree destructive)';
  if (sub === 'checkout-index' && forced) return 'git checkout-index --force (working-tree destructive)';
  if (sub === 'worktree' && rest[0] === 'remove' && forced) {
    return 'git worktree remove --force (working-tree destructive)';
  }
  return null;
}

/**
 * Classify a `git …` invocation for working-tree-destructive operations only
 * (NOT the full mutating set). Returns a descriptive reason, or null if the
 * invocation is not destructive to the working tree.
 *
 * Destructive set:
 *   - `checkout` / `switch`  — always, except a plain branch creation
 *                              (`checkout -b|-B`, `switch -c|-C`, see
 *                              `isPlainBranchCreation`)
 *   - `restore`              — except index-only --staged / -S
 *   - `clean`                — except --dry-run / -n
 *   - `reset --hard|--merge|--keep` — the forms that rewrite working-tree files
 *   - `stash drop/clear/pop/apply` — destroy stash entries or modify the tree
 *   - `read-tree -u`, `checkout-index -f`, `worktree remove --force`
 *   - an inline alias (`git -c alias.co=checkout co main`) expanding to any of these
 *
 * `depth` is the nesting level of the enclosing command string; it is only
 * consumed by a shell alias (`alias.x=!…`), whose body is classified as a
 * nested command.
 */
export function destructiveGitSegmentReason(argv: readonly string[], depth = 0): string | null {
  return gitArgvReason(argv, depth, true);
}

function gitArgvReason(argv: readonly string[], depth: number, expandAliases: boolean): string | null {
  if (argv.includes('--help') || argv.includes('-h')) return null;
  const { sub, rest } = gitSubcommand(argv);
  if (sub === undefined || sub === 'help') return null;
  if (expandAliases) {
    const alias = inlineGitAliases(argv).get(sub);
    if (alias !== undefined) return aliasReason(alias, rest, depth);
  }
  if (DESTRUCTIVE_GIT_SUBCMDS.has(sub)) {
    // Branch creation only adds a ref, so a child can still follow the
    // preamble's `git switch -c rescue-<name>` instruction.
    if ((sub === 'checkout' || sub === 'switch') && isPlainBranchCreation(sub, rest)) return null;
    if ((sub === 'restore' || sub === 'clean') && isNonDestructiveMode(sub, rest)) return null;
    return `git ${sub} (working-tree destructive)`;
  }
  if (sub === 'reset') {
    if (argv.includes('--hard')) return 'git reset --hard (working-tree destructive)';
    if (argv.includes('--merge')) return 'git reset --merge (working-tree destructive)';
    if (argv.includes('--keep')) return 'git reset --keep (working-tree destructive)';
    return null;
  }
  if (sub === 'stash') {
    const next = rest[0] ?? '';
    if (next === 'drop' || next === 'clear' || next === 'pop' || next === 'apply') {
      return `git stash ${next} (working-tree destructive)`;
    }
    return null;
  }
  return plumbingDestructiveReason(sub, rest);
}

/** Only actual options count: operands and paths named -n/--staged do not. */
function isNonDestructiveMode(sub: string, rest: readonly string[]): boolean {
  let safe = false;
  let worktree = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--') break;
    if (sub === 'restore') {
      if (['--source', '-s', '--pathspec-from-file'].includes(arg)) { i++; continue; }
      if (arg === '--staged') safe = true;
      if (arg === '--worktree') worktree = true;
      if (/^-[SW]+$/.test(arg)) {
        safe ||= arg.includes('S');
        worktree ||= arg.includes('W');
      }
      // Conservatively reject unrecognized/abbreviated options: e.g. --work.
      if (arg.startsWith('-') && !/^-[SW]+$/.test(arg)
        && !['--staged', '--worktree', '--pathspec-file-nul'].includes(arg)
        && !arg.startsWith('--source=') && !arg.startsWith('--pathspec-from-file=')) return false;
    } else {
      if (arg === '-e' || arg === '--exclude') { i++; continue; }
      if (arg === '--dry-run') safe = true;
      if (arg.startsWith('--') && !['--dry-run', '--force', '--quiet', '--interactive'].includes(arg)
        && !arg.startsWith('--exclude=')) return false;
      // -e consumes the rest of a short bundle (or the next argv word).
      if (/^-[^-]/.test(arg)) {
        const flags = arg.slice(1).split('e')[0]!;
        if (!/^[dfxXinq]*$/.test(flags)) return false;
        if (flags.includes('n')) safe = true;
        if (arg === `-${flags}e`) i++;
      }
    }
  }
  return safe && !worktree;
}

/**
 * Reason for an inline alias invocation. A `!`-prefixed alias runs its body
 * in a shell, so the body (plus the trailing args) is classified as a nested
 * command; any other alias is expanded once in place of the subcommand.
 */
function aliasReason(alias: string, rest: readonly string[], depth: number): string | null {
  if (alias.startsWith('!')) {
    const verdict = classifyDestructiveGit([alias.slice(1), ...rest].join(' '), depth + 1);
    return verdict.destructive ? `git shell alias: ${verdict.reason ?? 'destructive'}` : null;
  }
  const expanded = [...alias.split(/\s+/).filter(Boolean), ...rest];
  const reason = gitArgvReason(expanded, depth, false);
  return reason !== null ? `git alias: ${reason}` : null;
}

// Analogous to `hiddenGitMutation` (tokenizer) but narrowed to the destructive
// subset. When a compound-command keyword causes `resolveSegment` to return
// null — or when the resolved base is not `git` — the raw token list may still
// contain a literal `git` followed by a destructive subcommand.
function hiddenDestructiveGit(tokens: readonly string[], depth: number): string | null {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (baseName(tokens[i]!) === 'git') {
      const reason = destructiveGitSegmentReason(tokens.slice(i + 1), depth);
      if (reason !== null) return reason;
    }
  }
  return null;
}

// Pipe-to-shell backstop: `printf 'git checkout main' | bash`.
// tokenizeSegments splits on `|`; the git command is a string arg to
// printf/echo, not a parsed segment. If any segment is a shell interpreter
// (possibly preceded by sudo/env/command), re-parse each string argument from
// the preceding segment and recurse into classifyDestructiveGit.
function pipeToShellDestructiveGit(command: string, depth: number): Verdict | null {
  const segs = [...tokenizeSegments(command)];
  for (let idx = 1; idx < segs.length; idx++) {
    const seg = segs[idx]!;
    if (seg.length === 0) continue;
    let interpIdx = 0;
    while (interpIdx < seg.length - 1 && INTERP_WRAPPERS.has(baseName(seg[interpIdx]!))) {
      interpIdx++;
    }
    if (!SHELL_INTERPS.has(baseName(seg[interpIdx]!))) continue;
    const prevSeg = segs[idx - 1]!;
    for (const tok of prevSeg.slice(1)) {
      const inner = classifyDestructiveGit(tok, depth + 1);
      if (inner.destructive) return inner;
    }
  }
  return null;
}

/**
 * Classify one raw token segment: first any command string it hands to a
 * shell (`sh -c "…"`, `eval '…'`), then the segment itself (resolved through
 * wrappers and variables), then a bare `git` token hidden behind a compound
 * keyword. Returns null when the segment is not destructive.
 */
function classifySegment(
  rawTokens: readonly string[],
  vars: Map<string, string>,
  depth: number,
): Verdict | null {
  for (const payload of [...interpreterCommandStrings(rawTokens), ...evalPayloads(rawTokens)]) {
    const inner = classifyDestructiveGit(payload, depth + 1);
    if (inner.destructive) return inner;
  }
  const seg = resolveSegment(rawTokens, vars);
  const reason = seg !== null && baseName(seg.command) === 'git'
    ? destructiveGitSegmentReason(seg.argv, depth)
    : hiddenDestructiveGit(rawTokens, depth);
  return reason !== null ? { destructive: true, reason } : null;
}

/**
 * Classify a raw shell command string for working-tree-destructive git
 * commands. Returns `{ destructive: true, reason }` on the first matching
 * segment, or `{ destructive: false }` when none match.
 *
 * Tokenizes the command (reusing `tokenizeSegments`) and applies
 * `destructiveGitSegmentReason` to each resolved segment so wrappers such as
 * `sudo git checkout main` and variable substitutions such as `g=git; $g`
 * are caught correctly. Nested command strings (`sh -c`, `eval`, pipes into
 * a shell, a substitution used as the command name, `!` aliases) are
 * classified recursively; past `MAX_NESTING` levels any mention of git fails
 * closed. See the module comment for what this cannot see.
 *
 * @param depth - Nesting level; callers outside this module omit it.
 */
export function classifyDestructiveGit(command: string, depth = 0): Verdict {
  if (depth > MAX_NESTING) {
    return /\bgit\b/.test(command)
      ? { destructive: true, reason: 'git inside a deeply nested command (fail-closed)' }
      : { destructive: false };
  }
  const heredocs = destructiveGitHeredocView(command);
  if (heredocs.uncertain !== undefined) {
    return { destructive: true, reason: `${heredocs.uncertain} (fail-closed)` };
  }
  for (const script of heredocs.scripts) {
    const inner = classifyDestructiveGit(script, depth + 1);
    if (inner.destructive) return inner;
  }
  command = heredocs.command;
  const vars = new Map<string, string>();
  for (const rawTokens of tokenizeSegments(command)) {
    const verdict = classifySegment(rawTokens, vars, depth);
    if (verdict !== null) return verdict;
  }
  const piped = pipeToShellDestructiveGit(command, depth);
  if (piped !== null) return piped;
  for (const rewritten of substitutionRewrites(command)) {
    const inner = classifyDestructiveGit(rewritten, depth + 1);
    if (inner.destructive) return inner;
  }
  return { destructive: false };
}
