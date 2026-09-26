/**
 * Absolute-pattern support for the glob tool.
 *
 * The glob walker matches patterns against paths RELATIVE to its base
 * directory. An absolute pattern such as `/tmp/repo/src/foo*` can therefore
 * never match, so before this split the walker visited every entry under the
 * base (the session cwd, i.e. the whole repo) only to report "No files
 * matched". On a repo holding dozens of agent worktrees that walk took
 * minutes inside unattended cron subagents.
 *
 * Contract: `splitAbsolutePattern` returns `null` for relative patterns
 * (callers keep their existing behaviour). For an absolute pattern it returns
 * the longest literal (metacharacter-free) directory prefix as `base` and the
 * remainder as a relative `pattern`. The returned base is NOT trusted: the
 * caller must still pass it through `resolveAndContain` so read-root and
 * denylist enforcement are unchanged.
 */

import path from 'path';

export interface SplitPattern {
  /** Absolute directory to walk from (must still be containment-checked). */
  base: string;
  /** Pattern relative to `base`. Never empty. */
  pattern: string;
}

function hasGlobMeta(segment: string): boolean {
  return segment.includes('*') || segment.includes('?');
}

export function splitAbsolutePattern(rawPattern: string): SplitPattern | null {
  if (!path.isAbsolute(rawPattern)) return null;
  const normalized = rawPattern.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const firstMeta = segments.findIndex(hasGlobMeta);
  // No metacharacters: a plain file path. Walk its parent for its basename.
  const splitAt = firstMeta === -1 ? segments.length - 1 : firstMeta;
  const baseSegments = segments.slice(0, splitAt);
  const rest = segments.slice(splitAt).filter((s) => s !== '');
  if (rest.length === 0) return null;
  // `['', 'tmp', 'x']` -> '/tmp/x'; `['C:', 'x']` -> 'C:/x'; `['']` -> '/'.
  const joined = baseSegments.join('/');
  const base = joined === '' || /^[A-Za-z]:$/.test(joined) ? `${joined}/` : joined;
  return { base: path.normalize(base), pattern: rest.join('/') };
}
