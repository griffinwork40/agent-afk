/**
 * Working-tree-destructive git classifier.
 *
 * Extracted from `readonly-bash.tokenizer.ts` to keep that file within the
 * 350-code-line ceiling. Owns `DESTRUCTIVE_GIT_SUBCMDS`, `SHELL_INTERPS`,
 * `INTERP_WRAPPERS`, `destructiveGitSegmentReason`, and `classifyDestructiveGit`.
 *
 * @module agent/tools/readonly-bash.destructive-git
 */

import {
  baseName,
  gitSubcommand,
  tokenizeSegments,
  resolveSegment,
} from './readonly-bash.tokenizer.js';

/**
 * git subcommands that destroy working-tree state. A subset of
 * `GIT_MUTATING_SUBCMDS` — checked by `destructiveGitSegmentReason`.
 */
export const DESTRUCTIVE_GIT_SUBCMDS = new Set([
  'checkout', 'switch', 'restore', 'clean',
]);

/** Shell interpreters that execute a string argument — used by the pipe-to-shell backstop. */
const SHELL_INTERPS = new Set([
  'bash', 'sh', 'dash', 'zsh', 'ksh',
  '/bin/bash', '/bin/sh', '/bin/dash', '/bin/zsh', '/bin/ksh',
]);

/** Wrappers that prefix a shell interpreter without changing its identity (e.g. `sudo bash`). */
const INTERP_WRAPPERS = new Set(['sudo', 'env', 'command']);

/**
 * Classify a `git …` invocation for working-tree-destructive operations only
 * (NOT the full mutating set). Returns a descriptive reason, or null if the
 * invocation is not destructive to the working tree.
 *
 * Destructive set:
 *   - `checkout` / `switch`  — always (branch or file form both destroy state)
 *   - `restore`              — always (discards working-tree changes)
 *   - `clean`                — always (deletes untracked files)
 *   - `reset --hard`         — only the `--hard` form
 *   - `reset --merge`        — modifies working tree (aborts an in-progress merge)
 *   - `reset --keep`         — modifies working tree (updates index and files)
 *   - `stash drop/clear/pop` — destroy stash entries or modify working tree
 */
export function destructiveGitSegmentReason(argv: readonly string[]): string | null {
  if (argv.includes('--help') || argv.includes('-h')) return null;
  const { sub, rest } = gitSubcommand(argv);
  if (sub === undefined || sub === 'help') return null;
  if (DESTRUCTIVE_GIT_SUBCMDS.has(sub)) {
    // Branch-creation flags (-b/-B for checkout, -c/-C for switch) only create a
    // new branch and do not destroy working-tree state. Allow them so child
    // sessions can run `git switch -c rescue-<name>` as instructed in the preamble.
    if ((sub === 'checkout' && (argv.includes('-b') || argv.includes('-B'))) ||
        (sub === 'switch' && (argv.includes('-c') || argv.includes('-C')))) {
      return null;
    }
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
  }
  return null;
}

// Analogous to `hiddenGitMutation` (tokenizer) but narrowed to the destructive
// subset. When a compound-command keyword causes `resolveSegment` to return
// null — or when the resolved base is not `git` — the raw token list may still
// contain a literal `git` followed by a destructive subcommand.
function hiddenDestructiveGit(tokens: readonly string[]): string | null {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (baseName(tokens[i]!) === 'git') {
      const reason = destructiveGitSegmentReason(tokens.slice(i + 1));
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
function pipeToShellDestructiveGit(
  command: string,
): { destructive: boolean; reason?: string } | null {
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
      const inner = classifyDestructiveGit(tok);
      if (inner.destructive) return inner;
    }
  }
  return null;
}

/**
 * Classify a raw shell command string for working-tree-destructive git
 * commands. Returns `{ destructive: true, reason }` on the first matching
 * segment, or `{ destructive: false }` when none match.
 *
 * Tokenizes the command (reusing `tokenizeSegments`) and applies
 * `destructiveGitSegmentReason` to each resolved segment so wrappers such as
 * `sudo git checkout main` and variable substitutions such as `g=git; $g reset
 * --hard` are caught correctly.
 */
export function classifyDestructiveGit(
  command: string,
): { destructive: boolean; reason?: string } {
  const vars = new Map<string, string>();
  for (const rawTokens of tokenizeSegments(command)) {
    const seg = resolveSegment(rawTokens, vars);
    if (seg === null) {
      const hidden = hiddenDestructiveGit(rawTokens);
      if (hidden !== null) return { destructive: true, reason: hidden };
      continue;
    }
    const base = baseName(seg.command);
    if (base !== 'git') {
      const hidden = hiddenDestructiveGit(rawTokens);
      if (hidden !== null) return { destructive: true, reason: hidden };
      continue;
    }
    const reason = destructiveGitSegmentReason(seg.argv);
    if (reason !== null) return { destructive: true, reason };
  }
  const piped = pipeToShellDestructiveGit(command);
  if (piped !== null) return piped;
  return { destructive: false };
}
