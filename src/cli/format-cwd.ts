/**
 * Format the session's working directory for compact display.
 *
 * Goals:
 *   - Tildify the user's home directory so `/Users/jane/Projects/foo` reads
 *     as `~/Projects/foo` (familiar to anyone who's used a shell).
 *   - Stay readable on narrow terminals by collapsing interior segments to
 *     `…` rather than truncating the leaf — the leaf is the identity signal
 *     ("which project am I in?"), the interior is context.
 *   - Never lengthen the input. If the path already fits the budget, return
 *     it unchanged (sans tildify).
 *
 * Examples (homedir = /Users/jane, maxWidth = 30):
 *   /Users/jane                                  → ~
 *   /Users/jane/Projects/foo                     → ~/Projects/foo
 *   /Users/jane/Projects/foo/.afk-worktrees/bar  → ~/Projects/foo/…/bar
 *
 * No ANSI codes are emitted — coloring is the caller's responsibility.
 */

import { homedir as defaultHomedir } from 'node:os';
import { sep } from 'node:path';
import { displayWidth, truncateDisplayWidth } from './display.js';

export interface FormatCwdOptions {
  /** Override homedir resolution for tests. Defaults to `os.homedir()`. */
  homedir?: string;
  /** Hard upper bound on display width. When omitted, no shortening occurs. */
  maxWidth?: number;
}

/**
 * Tildify the path and shorten it to fit `maxWidth` columns. Returns the
 * untouched (but tildified) path when shortening isn't required.
 */
export function formatCwd(cwd: string, opts: FormatCwdOptions = {}): string {
  if (!cwd) return '';
  const home = opts.homedir ?? defaultHomedir();
  const tildified = tildify(cwd, home);
  const max = opts.maxWidth;
  if (max === undefined || max <= 0) return tildified;
  if (displayWidth(tildified) <= max) return tildified;

  // Always preserve the leaf segment. Collapse interior segments to `…`
  // walking outward until the result fits, or fall back to a hard truncate
  // when even `~/…/<leaf>` doesn't fit.
  const segments = tildified.split(sep).filter((s) => s.length > 0);
  if (segments.length <= 1) {
    return truncateDisplayWidth(tildified, max);
  }
  // The head is the leftmost visible anchor: `~` when tildified, the first
  // real segment otherwise. `interiorStartIdx` is the index in `segments`
  // where the *interior* (drop-able) middle begins — i.e. just past the head.
  const tildified_ = tildified;
  const head = tildified_.startsWith('~') ? '~' : segments[0]!;
  const interiorStartIdx = 1;
  const tail = segments[segments.length - 1]!;
  // Try progressively shorter prefixes: keep `<head>/<some-interior>/…/<tail>`,
  // dropping interior segments one at a time from the right (closer to tail)
  // outward until we fit the budget.
  const candidates: string[] = [];
  for (let lastKept = segments.length - 2; lastKept >= interiorStartIdx; lastKept--) {
    const interior = segments.slice(interiorStartIdx, lastKept + 1);
    const body = interior.length > 0 ? interior.join(sep) + sep : '';
    candidates.push(`${head}${sep}${body}…${sep}${tail}`);
  }
  // Final fallback: just `<head>/…/<tail>` (when head=`~`, that's `~/…/<tail>`).
  candidates.push(`${head}${sep}…${sep}${tail}`);
  for (const c of candidates) {
    if (displayWidth(c) <= max) return c;
  }
  // Even the shortest candidate doesn't fit — hard-truncate it.
  return truncateDisplayWidth(candidates[candidates.length - 1]!, max);
}

function tildify(path: string, home: string): string {
  if (!home) return path;
  if (path === home) return '~';
  // Match `<home>/...` but not `<home>foo` (different directory that happens
  // to share a prefix).
  const prefix = home.endsWith(sep) ? home : home + sep;
  if (path.startsWith(prefix)) {
    return '~' + sep + path.slice(prefix.length);
  }
  return path;
}
