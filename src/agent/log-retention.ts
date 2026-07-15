/**
 * Bounded retention for append-only JSONL logs.
 *
 * The first (and currently only) consumer is `session-grants.jsonl`, a
 * write-only forensic audit log that grew to 46MB from an already-fixed
 * duplication bug (PR #449). This module provides a best-effort, atomic
 * size-cap that keeps the newest N lines. Designed to be reused by a future
 * class-wide log sweep for the other write-only logs.
 *
 * @module agent/log-retention
 */

import { stat, readFile, writeFile, rename, unlink } from 'node:fs/promises';

/**
 * Size cap for the session-grants audit log (`session-grants.jsonl`) and how
 * many of the newest lines to preserve when the cap is exceeded.
 *
 * Hardcoded rather than env-tunable, mirroring the repl-history cap
 * (`src/cli/input/history.ts` `MAX_ENTRIES`): a forensic audit log that grows
 * ~1 row per genuine grant post-#449 does not warrant an operator knob. The
 * ~750KB tail floor (5k lines) vs 5MB ceiling gives hysteresis so the trim
 * fires rarely, not on every boot.
 */
export const SESSION_GRANTS_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
export const SESSION_GRANTS_KEEP_TAIL_LINES = 5_000;

export interface CapJsonlOptions {
  /** Rewrite the file only when its on-disk size exceeds this many bytes. */
  maxBytes: number;
  /** Number of newest (trailing) lines to keep when rewriting. */
  keepTailLines: number;
}

export interface CapJsonlResult {
  /** True when the file was over `maxBytes` and was rewritten. */
  trimmed: boolean;
  /** Count of leading (oldest) lines dropped; 0 when not trimmed. */
  removedLines: number;
}

// Invariant: this trim is safe to run ONLY off the write hot-path (e.g. once at
// session bootstrap), never inline per append. session-grants.jsonl is written
// with O_APPEND by multiple concurrent processes (REPL, daemon, telegram) and
// by in-process subagent forks. The read-then-atomic-rename below is NOT
// serialised against those appenders: any line appended between the readFile
// and the rename is dropped. Running once at top-level bootstrap bounds that
// loss to the rare two-simultaneous-boots case, acceptable for a write-only
// forensic audit log (no production code reads it) but a per-grant data-loss
// bug if wired into the append sites.
/**
 * Cap an append-only JSONL file at `maxBytes`, keeping the newest
 * `keepTailLines` lines. Atomic (temp sibling + rename, so a crash mid-write
 * leaves the original intact) and best-effort: never throws — a missing file,
 * permission error, ENOSPC, or race is swallowed and reported as
 * `{ trimmed: false }`.
 */
export async function capJsonlBySize(
  path: string,
  { maxBytes, keepTailLines }: CapJsonlOptions,
): Promise<CapJsonlResult> {
  const noop: CapJsonlResult = { trimmed: false, removedLines: 0 };
  let tmp: string | undefined;
  try {
    const st = await stat(path);
    if (st.size <= maxBytes) return noop;

    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n');
    // `split` yields a trailing '' for a file ending in '\n'; drop it so the
    // line count reflects real records and we can re-add exactly one newline.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    // Over the byte cap but at/under the line budget: a few pathologically long
    // lines. Nothing safe to drop by line count — leave the file untouched.
    if (lines.length <= keepTailLines) return noop;

    const kept = lines.slice(lines.length - keepTailLines);
    const removedLines = lines.length - kept.length;

    // Unique temp name (pid + random) so concurrent same-process trims of the
    // same path never clobber each other's staging file.
    tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    await writeFile(tmp, kept.join('\n') + '\n', { mode: 0o600 });
    await rename(tmp, path);
    tmp = undefined; // renamed away — nothing to clean up
    return { trimmed: true, removedLines };
  } catch {
    if (tmp !== undefined) {
      try {
        await unlink(tmp);
      } catch {
        /* temp already gone or unremovable — ignore */
      }
    }
    return noop;
  }
}
