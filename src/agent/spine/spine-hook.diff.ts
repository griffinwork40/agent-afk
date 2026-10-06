/**
 * Diff-acquisition helpers for the SPINE SessionEnd hook.
 *
 * Extracted from spine-hook.ts to keep that file under the 350-code-line
 * ceiling (#2206). This module owns:
 *
 *  1. Fetching the working-tree diff from the session's own worktree root
 *     (`show-toplevel` from `cwd`) rather than the main checkout's root.
 *
 *  2. Filtering SPINE.md and the SPINE pending log out of the diff before
 *     it reaches the classifier — self-referential edits must never drive
 *     new invariants or trigger "conflict" alerts.
 *
 *  3. Fingerprinting the filtered diff with SHA-256 so a repeated identical
 *     diff (e.g. the main checkout's 145 stale staged files lingering across
 *     multiple unrelated sessions) is classified at most once, keyed by the
 *     worktree root so linked worktrees / different repos don't evict each
 *     other's fingerprints.
 *
 * @module agent/spine/spine-hook.diff
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { getSpineDiffFingerprintPath } from '../../paths.spine.js';
import { resolveRepoRootSync } from '../../utils/git.js';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Result of `getClassifiableDiff`.
 *
 * Contract:
 *  - `diff` is the filtered, classifier-ready diff string.
 *  - `fingerprint` is its SHA-256 hex digest (of the raw filtered bytes).
 *  - `worktreeRoot` is the git worktree toplevel used for diff acquisition and
 *    fingerprint-key scoping.
 *  - `skipped` is true when the filtered diff is empty (SPINE-only changes or
 *    nothing at all) — the hook must fast-exit without calling the classifier.
 */
export interface DiffResult {
  diff: string;
  fingerprint: string;
  worktreeRoot: string;
  skipped: boolean;
}

/**
 * Fetch and filter the working-tree diff for the session's own worktree.
 *
 * History: the original hook used `mode: 'git-common-dir'` for the diff, which
 * caused every worktree session to classify the MAIN checkout's uncommitted
 * changes instead of its own (#worktree-diff-bug). This function corrects that
 * by running `git diff HEAD` with the worktree's own `--show-toplevel` root as
 * cwd. SPINE.md is still written to the common-dir root in spine-hook.ts,
 * preserving the original #worktree-spine-bug fix.
 *
 * @param worktreeCwd  The session's working directory (used for `show-toplevel`).
 * @param fallbackRoot Returned when git is unavailable (matches existing behaviour).
 */
export function getClassifiableDiff(
  worktreeCwd: string,
  fallbackRoot: string,
): DiffResult {
  // Invariant: use show-toplevel so a session running in a linked worktree
  // classifies ITS OWN uncommitted changes, not the main checkout's.
  const worktreeRoot = resolveRepoRootSync({
    cwd: worktreeCwd,
    fallback: fallbackRoot,
    mode: 'show-toplevel',
  });

  const rawDiff = fetchRawDiff(worktreeRoot);
  if (!rawDiff.trim()) {
    return { diff: '', fingerprint: '', worktreeRoot, skipped: true };
  }

  const filtered = filterSpineEdits(rawDiff);
  if (!filtered.trim()) {
    return { diff: '', fingerprint: '', worktreeRoot, skipped: true };
  }

  const fingerprint = sha256hex(filtered);
  return { diff: filtered, fingerprint, worktreeRoot, skipped: false };
}

/**
 * Return true when `fingerprint` matches the last-persisted diff fingerprint
 * for `worktreeRoot`.
 *
 * Each worktree root is keyed independently in the fingerprint map so linked
 * worktrees of the same repository do not evict each other's fingerprints.
 *
 * An identical fingerprint means this exact diff has already been classified;
 * the hook should skip the classifier call and return early.
 */
export function isDuplicateDiff(fingerprint: string, worktreeRoot: string): boolean {
  try {
    const map = readFingerprintMap();
    const key = rootKey(worktreeRoot);
    return map[key] === fingerprint;
  } catch {
    // File does not exist yet — first run, not a duplicate.
    return false;
  }
}

/**
 * Persist `fingerprint` as the last-classified diff fingerprint for `worktreeRoot`.
 *
 * The fingerprint map is keyed by a short hash of the repo root, so each project
 * has exactly one entry and the file stays well under 1 KB even across many repos.
 *
 * Best-effort — never throws; a failed write just means the next session may
 * re-classify the same diff once more, which is safe.
 */
export function persistDiffFingerprint(fingerprint: string, worktreeRoot: string): void {
  try {
    const p = getSpineDiffFingerprintPath();
    mkdirSync(dirname(p), { recursive: true });
    const map = readFingerprintMap();
    map[rootKey(worktreeRoot)] = fingerprint;
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(map) + '\n', 'utf-8');
    renameSync(tmp, p);
  } catch {
    // Best-effort — fingerprint is an optimisation, not a correctness requirement.
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derive a short stable key for a worktree root path.
 *
 * Uses the first 16 hex characters of sha256(worktreeRoot) — collision probability
 * is negligible for the ≤10 repos a typical AFK user works with, and the key
 * is short enough that the JSON file stays well under 1 KB.
 */
function rootKey(worktreeRoot: string): string {
  return sha256hex(worktreeRoot).slice(0, 16);
}

/** Read the persisted fingerprint map, returning {} on any error. */
function readFingerprintMap(): Record<string, string> {
  try {
    const raw = readFileSync(getSpineDiffFingerprintPath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] =>
          typeof entry[1] === 'string',
        ),
      );
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Run `git diff HEAD --unified=0` in `root` and return the raw output.
 *
 * Returns '' on any error (no commits yet, git absent, etc.) to preserve the
 * existing fast-exit behaviour in the hook.
 */
function fetchRawDiff(root: string): string {
  try {
    return execFileSync('git', ['diff', 'HEAD', '--unified=0'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 2 * 1024 * 1024, // 2 MB cap
    });
  } catch {
    return '';
  }
}

/**
 * Remove all hunks that touch SPINE.md or spine-pending.jsonl from `diff`.
 *
 * Invariant: the hook writes SPINE.md at the end of each session, so a diff
 * captured at session end will include SPINE.md modifications. Feeding those
 * back through the classifier produces meta-invariants about SPINE.md hygiene
 * and duplicate entries (observed: INV-058..INV-073 in the main checkout).
 * Filtering them before classification breaks the self-reference loop.
 *
 * Contract:
 *  - A `diff --git` hunk header matching `b/SPINE.md` or `b/spine-pending.jsonl`
 *    is excluded along with every line up to the next `diff --git` header.
 *  - The filter is purely textual; it never re-parses git output.
 *  - Only root-level occurrences are matched: the comparison uses the canonical
 *    git diff path format `a/<file> b/<file>` with no leading directory component.
 *    Files relocated into a subdirectory (e.g. `docs/SPINE.md`) will NOT be
 *    filtered and will pass through to the classifier unchanged. This is intentional
 *    — the hook only self-references the root-level SPINE.md that it writes.
 *    If SPINE.md is ever moved, update SPINE_FILES to include the new path.
 */
function filterSpineEdits(diff: string): string {
  // Invariant: git diff uses "diff --git a/... b/..." as the chunk separator.
  const SPINE_FILES = ['SPINE.md', 'spine-pending.jsonl'];
  const lines = diff.split('\n');
  const out: string[] = [];
  let skippingHunk = false;

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      skippingHunk = SPINE_FILES.some((f) => line === `diff --git a/${f} b/${f}`);
    }
    if (!skippingHunk) out.push(line);
  }

  return out.join('\n');
}

/**
 * Compute the SHA-256 hex digest of a string (UTF-8 encoded).
 */
function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
