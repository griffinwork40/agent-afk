/**
 * Pure helpers for scripts/check-new-clones.ts.
 * Extracted into a lib so unit tests can import them without triggering
 * the script's top-level `main()` call.
 */

import { execFileSync } from 'node:child_process';

/**
 * Returns true when `git merge-base <baseRef> HEAD` succeeds (merge-base
 * exists in local history — typically a full clone or a sufficiently deep
 * shallow fetch).
 *
 * On CI's depth=1 checkout the merge-base commit is absent and git exits
 * non-zero; this function catches that and returns false so the caller can
 * fall back to a two-dot diff.
 */
export function hasMergeBase(baseRef: string): boolean {
  try {
    execFileSync('git', ['merge-base', baseRef, 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the output of `git diff --unified=0 --diff-filter=ACMR` into a map
 * of relative path → set of added line numbers.
 */
export function parseDiffOutput(raw: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  let currentFile: string | null = null;

  for (const line of raw.split('\n')) {
    // +++ b/src/foo.ts
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }
    // @@ -old,count +new,count @@
    if (line.startsWith('@@') && currentFile) {
      const m = line.match(/\+(\d+)(?:,(\d+))?/);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] !== undefined ? Number(m[2]) : 1;
      let set = map.get(currentFile);
      if (!set) {
        set = new Set();
        map.set(currentFile, set);
      }
      for (let i = start; i < start + count; i++) {
        set.add(i);
      }
    }
  }
  return map;
}

/**
 * A single file fragment as reported by jscpd.
 * Kept here so the pure filtering helper can be unit-tested without importing
 * the top-level script (which calls `main()` on load).
 */
export interface CloneFile {
  name: string;
  start: number;
  end: number;
  startLoc: { line: number };
  endLoc: { line: number };
}

/**
 * Return true when any line in `frag` appears in the set of added lines from
 * the PR diff.
 */
export function fragmentOverlapsAdded(
  frag: CloneFile,
  added: Map<string, Set<number>>,
): boolean {
  const lines = added.get(frag.name);
  if (!lines) return false;
  const startLine = frag.startLoc.line;
  const endLine = frag.endLoc.line;
  for (let l = startLine; l <= endLine; l++) {
    if (lines.has(l)) return true;
  }
  return false;
}
