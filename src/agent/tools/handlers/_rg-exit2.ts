/**
 * Classifier for ripgrep's exit-code-2 stderr, shared by the grep handler.
 *
 * rg exits 2 for every "something went wrong" cause: a search path that does
 * not exist, a path it may not read, an unparseable regex. Those are not the
 * same event. A nonexistent path is a caller-supplied bad reference — ordinary
 * exploration, a typo, stale memory of a moved file — while a regex error or a
 * permission failure is worth a human's attention. Splitting them lets the
 * former carry `failureClass: 'no-such-target'` (benign: neutral glyph in the
 * tool lane, excluded from failure-density stats) while the latter stays an
 * unclassified, alarming failure.
 *
 * Lives in its own module because `grep.ts` sits at the project's 350-LOC
 * ceiling, and because the stderr-shape matching below is worth unit-testing
 * without spawning a real ripgrep.
 *
 * @module agent/tools/handlers/_rg-exit2
 */

import type { ToolFailureClass } from '../../trace/types.js';
import { capForModel } from './_output-cap.js';

/**
 * Contract: the shape `grep.ts`'s `settle()` accepts. Declared here rather than
 * inline in `grep.ts` because that file sits at the 350-LOC ceiling, and
 * because this module is the only producer that populates `failureClass`.
 */
export interface GrepSettleResult {
  content: string;
  isError?: boolean;
  truncated?: boolean;
  failureClass?: ToolFailureClass;
}

/** An exit-2 outcome is always an error; only the classification varies. */
export type RgExit2Result = GrepSettleResult & { isError: true };

// Invariant: these are ripgrep's own stderr spellings, verified against the
// bundled rg (15.x) — not guesses. `os error 2` is ENOENT and appears in two
// forms depending on how many paths rg was handed:
//
//   rg: <path>: IO error for operation on <path>: No such file or directory (os error 2)
//   rg: <path>: No such file or directory (os error 2)
//
// Both end with the `(os error 2)` sentinel, so anchoring on the tail matches
// either without parsing the prefix. Causes that MUST NOT match here:
//
//   rg: <path>: Permission denied (os error 13)   → readable-target problem, alarming
//   rg: regex parse error: …\n    ^\nerror: …     → caller's pattern, alarming
//
// Matching on the trailing sentinel rather than a substring keeps `os error 13`
// out even though its line is otherwise shaped identically. If ripgrep ever
// changes this wording the classifier degrades to the generic branch — the
// pre-existing behavior — never to a wrong classification.
const ENOENT_LINE_RE = /No such file or directory \(os error 2\)$/;

/**
 * Contract: given ripgrep's captured stderr and the resolved search path,
 * return the exit-2 result for the grep handler.
 *
 * Classifies as `no-such-target` only when EVERY non-empty stderr line is an
 * ENOENT line and at least one of them names `searchPath` — i.e. the sole
 * reason rg failed is that the requested target is absent, so nothing was
 * searched. Any other line (permission denied, regex parse error, an
 * unrecognized message) makes the whole result generic: a mixed stderr means
 * something beyond a bad path went wrong, and silently reporting it as a
 * missing path would hide the real fault.
 *
 * `isError` is `true` in both branches. A nonexistent path must never read as
 * "no matches" — that would let a typo become a false "this code does not
 * exist" conclusion, which is a far worse failure than a visible error.
 */
export function classifyRgExit2(stderr: string, searchPath: string): RgExit2Result {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const onlyEnoent = lines.length > 0 && lines.every((line) => ENOENT_LINE_RE.test(line));
  if (onlyEnoent && lines.some((line) => line.includes(searchPath))) {
    return {
      content:
        `grep: no such path: ${searchPath} — nothing was searched. ` +
        'Verify the path with the `glob` tool, or omit `path` to search the session root.',
      isError: true,
      failureClass: 'no-such-target',
    };
  }

  // stderr may accumulate up to HARD_CAP_BYTES (e.g. a recursive search across
  // a tree with many unreadable files), so cap it to the model budget.
  const capped = capForModel(stderr.trim());
  return {
    content: `grep error: ${capped.content}`,
    isError: true,
    ...(capped.truncated ? { truncated: true } : {}),
  };
}
