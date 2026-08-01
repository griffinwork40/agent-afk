/**
 * Issue #579 O3 — the curated `rm -rf <generated-dir>` carve-out for AFK
 * autonomous mode.
 *
 * AFK's gate classifies ALL `rm` as `high` (BASH_HIGH at risk-classifier.ts:51-53
 * lists both `rm -rf` and `rm ` — stricter than the repo's own
 * `safe-destruct-detect.ts`, which calls recursive-only deletes "common and
 * usually safe"), so even a standalone `rm -rf node_modules` stalls on an
 * approval prompt nobody will answer. Callers must run a following install as
 * a separate bash call; compound shell commands intentionally fail closed.
 *
 * This module decides the narrow exception. It is deliberately a separate file
 * from the gate: the parsing/containment logic is the security-load-bearing
 * part and is unit-testable without constructing a gate.
 *
 * @module agent/afk-mode-rm-allowlist
 */

import path from 'path';
import { lstatSync } from 'fs';
import { spawnSync } from 'child_process';
import { safeRealpath } from './tools/handlers/write-denylist.js';

/**
 * In-workspace leaf directories whose recursive delete is a routine
 * clean-rebuild step. Adding a new safe target is a one-line addition here.
 */
const RM_RF_SAFE_LEAF_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cache',
  '__pycache__',
  '.turbo',
  '.parcel-cache',
  'out',
  'target',
]);

/** Shell metacharacters whose presence makes tokenization unreliable (glob
 *  expansion, variable interpolation, command substitution, chaining). `\r`
 *  and `\n` are included too: the bash tool runs commands via
 *  `spawn(cmd, { shell: true })`, a real `/bin/sh -c`, where a literal
 *  embedded newline is a statement separator identical to `;`. Tokenization
 *  below (`cmd.trim().split(/\s+/)`) treats `\n` as ordinary whitespace, so
 *  without this a command like `rm -rf node_modules\ndist` — two shell
 *  statements — would flatten into one token stream (`targets: ["node_modules",
 *  "dist"]`) and be evaluated as if it were a single validated `rm` call. */
const SHELL_METACHAR = /[*?$`(){};|&<>'"\\\r\n]/;

/**
 * True for a recursive-delete flag: `-r`, `-R`, any clustered short-flag run
 * containing r/R (`-rf`, `-fr`, `-rfv`), or the long `--recursive`.
 */
function isRecursiveFlag(token: string): boolean {
  if (token === '--recursive') return true;
  if (token.startsWith('--')) return false;
  return /^-[A-Za-z]+$/.test(token) && /[rR]/.test(token);
}

interface ParsedRm {
  targets: string[];
  recursive: boolean;
}

/**
 * Parse a plain `rm` command into its targets plus whether a recursive flag was
 * supplied. Returns `null` when the shape cannot be confidently parsed — the
 * command must start with `rm` (not `rmdir`, not `sudo rm`), carry no shell
 * metacharacters anywhere, and name at least one target.
 */
function parseRmCommand(cmd: string): ParsedRm | null {
  // Must start with `rm ` (word-boundary — not `rmdir`).
  if (!/^rm\b/.test(cmd)) return null;

  // Invariant: metacharacter rejection runs across the WHOLE command string,
  // before any token can be discarded as a flag. Bash performs expansion and
  // command substitution before `rm` ever sees its argv, so a substitution
  // hidden inside a flag-shaped token is executed even though it is not an
  // `rm` target. `rm -rf node_modules -v$(rm${IFS}-rf${IFS}/tmp/victim)` used
  // to pass this gate: the only collected target was `node_modules`, and the
  // `-v$(...)` token was skipped by the flag branch before the per-target
  // metachar check could inspect it — while the shell deleted /tmp/victim with
  // no operator approval. `${IFS}` deliberately dodges a space/`;&|` filter, so
  // scanning the raw string (not just targets) is the only sound placement.
  // This also subsumes the previous standalone `[;&|]` chaining guard.
  if (SHELL_METACHAR.test(cmd)) return null;

  const tokens = cmd.trim().split(/\s+/);
  const targets: string[] = [];
  let recursive = false;
  let pastFlags = false;
  // tokens[0] === 'rm'
  for (const t of tokens.slice(1)) {
    if (!pastFlags && t === '--') {
      pastFlags = true;
      continue;
    }
    if (!pastFlags && t.startsWith('-')) {
      if (isRecursiveFlag(t)) recursive = true;
      continue;
    }
    targets.push(t);
  }
  if (targets.length === 0) return null;
  return { targets, recursive };
}

/**
 * True when `resolved` may be treated as a disposable generated directory: an
 * existing directory, or a path that does not exist (so `rm -rf node_modules`
 * in an already-clean tree stays a permitted no-op). An existing regular file
 * — or any other stat error — fails CLOSED.
 */
function isGeneratedDirTarget(resolved: string, workspaceRoot: string): boolean {
  try {
    if (!lstatSync(resolved).isDirectory()) return false;

    // A familiar basename is not evidence that an existing directory is
    // disposable: repositories can legitimately track a `build/` or `out/`
    // source tree. `git check-ignore` deliberately does not report tracked
    // paths, so requiring a successful match protects both tracked content and
    // unignored user-authored directories. No repository / no git / any git
    // error is ambiguous and therefore fails closed.
    return spawnSync('git', ['check-ignore', '--quiet', '--', resolved], {
      cwd: workspaceRoot,
      stdio: 'ignore',
    }).status === 0;
  } catch (err) {
    // ENOENT: nothing there to delete, so the command is a harmless no-op.
    // Every other errno (EACCES, ELOOP, …) is ambiguous → fail closed.
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Decide whether an `rm` command that classified as `high` is a routine
 * in-workspace clean-rebuild (e.g. `rm -rf node_modules`) that AFK autonomous
 * mode should permit unattended.
 *
 * Returns `true` only when the command is a recursive delete, carries no shell
 * metacharacters, and EVERY target's basename is in the curated allowlist, is
 * an existing directory or absent, and resolves (symlink-deref'd) strictly
 * inside the workspace root. Fails CLOSED on any ambiguity.
 */
export function isSafeInWorkspaceRm(
  cmd: string,
  resolveBase: string,
  workspaceRoot: string,
): boolean {
  const parsed = parseRmCommand(cmd);
  if (parsed === null) return false;

  // The carve-out covers recursive DIRECTORY deletes only. A bare `rm build`
  // or `rm -f build` targets whatever `build` happens to be — including a
  // tracked script of that name, which is not a generated artifact — so it
  // stays `high` and is gated as before.
  if (!parsed.recursive) return false;

  const wsRoot = safeRealpath(workspaceRoot);
  for (const target of parsed.targets) {
    // Reject dangerous anchors lexically before resolution.
    if (
      target === '/' ||
      target === '.' ||
      target === '..' ||
      target === '~' ||
      target.startsWith('~/') ||
      target === '$HOME' ||
      target.startsWith('$HOME/')
    ) {
      return false;
    }
    // Reject `.git` explicitly (catastrophic history loss).
    if (target === '.git' || target.startsWith('.git/')) return false;

    // Resolve against the call's cwd and dereference symlinks.
    const resolved = safeRealpath(path.resolve(resolveBase, target));

    // Must be strictly inside the workspace root — NOT the root itself.
    if (resolved === wsRoot || !resolved.startsWith(wsRoot + path.sep)) return false;

    // Basename must be in the curated allowlist.
    if (!RM_RF_SAFE_LEAF_DIRS.has(path.basename(resolved))) return false;

    // Must be a generated directory (or absent), never an existing file.
    if (!isGeneratedDirTarget(resolved, wsRoot)) return false;
  }
  return true;
}
