/**
 * Minimal line-based unified-diff generator.
 *
 * Produces a structured {@link DiffPayload} from two text snapshots —
 * an array of hunks, each carrying a contiguous region of context /
 * insertion / deletion lines plus old-/new-side starting line numbers.
 *
 * Owned in-tree (rather than depending on `diff` from npm) because the
 * scope is tiny — line-LCS, hunk-window — and avoiding the audit surface
 * is worth ~80 LOC of code we control.
 *
 * Pure & deterministic — no I/O, no global state. Suitable for both the
 * file-mutation tool handlers (`edit_file`, `write_file`) and unit tests.
 *
 * @module utils/diff
 */

/** A single line in a hunk. */
export interface DiffLine {
  /** `' '` context, `'+'` insertion, `'-'` deletion. */
  kind: ' ' | '+' | '-';
  text: string;
}

/** A contiguous region of changed lines plus its surrounding context. */
export interface DiffHunk {
  /** 1-based starting line number on the OLD (pre-change) side. */
  oldStart: number;
  /** Number of OLD-side lines in this hunk (context + deletions). */
  oldLines: number;
  /** 1-based starting line number on the NEW (post-change) side. */
  newStart: number;
  /** Number of NEW-side lines in this hunk (context + insertions). */
  newLines: number;
  lines: DiffLine[];
}

/** A structured render-only diff payload. */
export interface DiffPayload {
  hunks: DiffHunk[];
  /** Total `+` line count across all hunks. */
  addedLines: number;
  /** Total `-` line count across all hunks. */
  removedLines: number;
}

/**
 * Lines around each change region retained for context. Three lines on
 * each side matches `git diff` defaults and is enough to give a reviewer
 * a sense of position without ballooning the payload.
 */
const CONTEXT_LINES = 3;

/**
 * Hard cap on the DP table cell count for LCS computation.
 *
 * An m×n LCS DP table costs O(m·n) time AND space. For a 5 000-line file
 * that is ~25 M cells × 4 bytes = ~100 MB of synchronous heap allocation,
 * which blocks the Node.js event loop for hundreds of milliseconds.
 *
 * We bail out early when `(m+1) * (n+1)` would exceed this limit and
 * return a trivial edit script (all-delete + all-insert) so callers still
 * get a valid — if coarse — diff. The constant is chosen to keep the
 * worst-case allocation under ~16 MB (4 000 000 cells × 4 bytes).
 */
const MAX_DIFF_CELLS = 4_000_000;

/**
 * Split text into lines, treating both `\n` and `\r\n` as line terminators.
 *
 * When the input ends with a newline, JS `String.split` produces a spurious
 * trailing empty string (e.g. `'a\n'.split(…)` → `['a', '']`). That empty
 * element makes `'a\n'` and `'a'` produce different line arrays even though
 * both represent a single line of content, causing a spurious empty-line
 * deletion when diffing the two. We strip exactly one trailing empty element
 * when the input ends with a newline terminator to keep the representation
 * consistent. Files with intentional blank trailing lines (e.g. `'a\n\n'`)
 * still produce the correct `['a', '']` because only the very last — and
 * terminally-placed — empty string is removed.
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split(/\r?\n/);
  // Strip the artifact empty string that split() appends when the input ends
  // with a newline. Only remove if the last element is empty AND the text
  // actually ends with a newline — the two conditions are equivalent but the
  // explicit check makes the intent clear.
  if (parts.length > 0 && parts[parts.length - 1] === '' && /\r?\n$/.test(text)) {
    parts.pop();
  }
  return parts;
}

/**
 * Tag the edit-script entries produced by an LCS walk. `same` lines exist
 * in both snapshots; `add` are insertions, `del` are deletions.
 */
type EditOp =
  | { op: 'same'; text: string }
  | { op: 'add'; text: string }
  | { op: 'del'; text: string };

/**
 * Compute a line-level edit script via LCS dynamic programming.
 *
 * O(m·n) time and space. Acceptable for the scopes this is called on —
 * file edits in an interactive session, capped by handler write size.
 * For huge files (~10k lines) we'd want a Myers/diff-match-patch impl;
 * those don't happen through the model's edit tools.
 */
function computeEditScript(oldLines: string[], newLines: string[]): EditOp[] {
  const m = oldLines.length;
  const n = newLines.length;

  // Safety valve: bail out before allocating a table that would block the
  // event loop. Return a trivial all-delete-then-all-insert edit script so
  // callers still receive a structurally valid (if coarse) diff.
  if ((m + 1) * (n + 1) >= MAX_DIFF_CELLS) {
    const ops: EditOp[] = [];
    for (const text of oldLines) ops.push({ op: 'del', text });
    for (const text of newLines) ops.push({ op: 'add', text });
    return ops;
  }

  // dp[i][j] = length of LCS for oldLines[0..i) vs newLines[0..j).
  // Single Int32Array sized (m+1)*(n+1) for cache locality.
  const stride = n + 1;
  const dp = new Int32Array((m + 1) * stride);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i * stride + j] = dp[(i - 1) * stride + (j - 1)]! + 1;
      } else {
        const up = dp[(i - 1) * stride + j]!;
        const left = dp[i * stride + (j - 1)]!;
        dp[i * stride + j] = up >= left ? up : left;
      }
    }
  }

  // Backtrack from (m, n) producing the edit script in reverse, then flip.
  const ops: EditOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ op: 'same', text: oldLines[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i * stride + (j - 1)]! >= dp[(i - 1) * stride + j]!)) {
      ops.push({ op: 'add', text: newLines[j - 1]! });
      j--;
    } else {
      ops.push({ op: 'del', text: oldLines[i - 1]! });
      i--;
    }
  }
  ops.reverse();
  return ops;
}

/**
 * Walk the edit script and emit hunks.
 *
 * Hunk-splitting rule (matches `git diff`): a hunk starts at the first
 * change after a gap of more than `2 * CONTEXT_LINES` consecutive `same`
 * ops (or at the start of the script). Within a hunk, runs of `same` ops
 * of length ≤ `2 * CONTEXT_LINES` are kept inline as interior context.
 * The hunk closes after at most `CONTEXT_LINES` trailing `same` ops once
 * no further change is within reach.
 */
function buildHunks(ops: EditOp[]): DiffHunk[] {
  // Precompute, for each index, the offset to the next non-`same` op (or
  // ops.length if none). Used to decide whether a run of `same` ops sits
  // between two changes (keep inline) or trails the last change in a hunk
  // (cap at CONTEXT_LINES). Linear right-to-left scan.
  const nextChangeAt = new Int32Array(ops.length + 1);
  nextChangeAt[ops.length] = ops.length;
  for (let k = ops.length - 1; k >= 0; k--) {
    nextChangeAt[k] = ops[k]!.op === 'same' ? nextChangeAt[k + 1]! : k;
  }

  const hunks: DiffHunk[] = [];
  let oldIdx = 1; // 1-based current position on the OLD side
  let newIdx = 1; // 1-based current position on the NEW side

  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.op === 'same') {
      oldIdx++;
      newIdx++;
      i++;
      continue;
    }

    // Hunk start — look back up to CONTEXT_LINES `same` ops for prefix context.
    let prefixStart = i;
    let prefixCount = 0;
    while (prefixStart > 0 && ops[prefixStart - 1]!.op === 'same' && prefixCount < CONTEXT_LINES) {
      prefixStart--;
      prefixCount++;
    }
    const oldStart = Math.max(1, oldIdx - prefixCount);
    const newStart = Math.max(1, newIdx - prefixCount);

    const lines: DiffLine[] = [];
    let hunkOld = 0;
    let hunkNew = 0;

    // Emit prefix context.
    for (let k = prefixStart; k < i; k++) {
      lines.push({ kind: ' ', text: ops[k]!.text });
      hunkOld++;
      hunkNew++;
    }

    // Consume the change region. A run of `same` ops is interior context
    // (kept inline) iff there's another change within 2*CONTEXT_LINES;
    // otherwise close the hunk after CONTEXT_LINES of trailing context.
    let done = false;
    while (!done && i < ops.length) {
      const op = ops[i]!;
      if (op.op === 'same') {
        // Distance from `i` to the next change op (or end of ops).
        const nextChange = nextChangeAt[i]!;
        const distance = nextChange - i;
        // "Tail" = no further change exists in the script.
        const isTail = nextChange === ops.length;
        if (isTail || distance > 2 * CONTEXT_LINES) {
          // No nearby change — emit up to CONTEXT_LINES trailing context, stop.
          for (let k = 0; k < CONTEXT_LINES && i < ops.length && ops[i]!.op === 'same'; k++) {
            lines.push({ kind: ' ', text: ops[i]!.text });
            hunkOld++;
            hunkNew++;
            oldIdx++;
            newIdx++;
            i++;
          }
          done = true;
        } else {
          // Nearby change — keep this `same` as interior context.
          lines.push({ kind: ' ', text: op.text });
          hunkOld++;
          hunkNew++;
          oldIdx++;
          newIdx++;
          i++;
        }
      } else if (op.op === 'add') {
        lines.push({ kind: '+', text: op.text });
        hunkNew++;
        newIdx++;
        i++;
      } else {
        lines.push({ kind: '-', text: op.text });
        hunkOld++;
        oldIdx++;
        i++;
      }
    }

    hunks.push({ oldStart, oldLines: hunkOld, newStart, newLines: hunkNew, lines });
  }

  return hunks;
}

/**
 * Produce a {@link DiffPayload} comparing `before` vs `after`.
 *
 * Returns `null` if the two snapshots are byte-identical — the caller
 * should omit the payload in that case so renderers don't draw an empty
 * block (no-op edits are legal and produce no visual change).
 */
export function computeLineDiff(before: string, after: string): DiffPayload | null {
  if (before === after) return null;

  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const ops = computeEditScript(oldLines, newLines);
  const hunks = buildHunks(ops);

  // Empty hunks list shouldn't happen when before !== after, but guard.
  if (hunks.length === 0) return null;

  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.kind === '+') added++;
      else if (line.kind === '-') removed++;
    }
  }

  return { hunks, addedLines: added, removedLines: removed };
}
