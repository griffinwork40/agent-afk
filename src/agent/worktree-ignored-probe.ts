/**
 * Non-rebuildable ignored-file probe for the worktree sweep.
 *
 * Invariant: `git status --porcelain` — the sweep's only dirty signal — reports
 * untracked files but NEVER ignored ones. A worktree whose sole contents are
 * ignored therefore reads CLEAN, becomes eligible for `git worktree remove
 * --force`, and has those files deleted along with the checkout. Committed work
 * is never lost that way (branch refs live in the shared `.git`), but a
 * worktree-local `.env`, a scratch fixture, or an un-ignored-by-habit secrets
 * file is unrecoverable (#759).
 *
 * Contract: this probe distinguishes REBUILDABLE ignored artifacts from
 * non-rebuildable local state, and it must. Treating *any* ignored entry as
 * protective would make effectively every worktree immortal — `node_modules/`
 * and `dist/` are ignored in every checkout — defeating the sweep entirely and
 * regrowing the very leak it exists to prevent. So the default stays
 * "reapable": only an ignored entry that does NOT match a known-rebuildable
 * pattern protects the tree. Classification policy lives in
 * `worktree-ignored-patterns.ts`; this module is the IO around it.
 *
 * Fail-safe direction: anything unrecognised is treated as non-rebuildable
 * (protect), and a git failure also protects — mirroring the sweep's existing
 * `catch { isDirty = true }` posture, where the safe answer is "leave it alone".
 *
 * @module agent/worktree-ignored-probe
 */

import type { ExecFileFn } from './worktree-sweep.js';
import { classifyIgnoredEntry } from './worktree-ignored-patterns.js';

export {
  classifyIgnoredEntry,
  isSensitiveLeaf,
  type IgnoredEntryClass,
} from './worktree-ignored-patterns.js';

/**
 * Invariant: `core.quotePath=false` is not optional. With git's default, a
 * non-ASCII ignored path arrives wrapped in double quotes and octal-escaped
 * (`"caf\303\251/node_modules/"`), which defeats the `(?:^|\/)` anchors in
 * every rebuildable pattern. The entry then reads "unrecognised", protects the
 * tree, and the worktree becomes immortal — the leak the sweep exists to stop.
 */
const GIT_LITERAL_PATHS = ['-c', 'core.quotePath=false'];

/**
 * Invariant: a scoped `--untracked-files=all` expansion of a populated `dist/`
 * or `target/` can print far more than Node's 1MB default, and an execFile
 * maxBuffer overflow REJECTS rather than truncating. Without a raised ceiling
 * the reject lands in the `catch` below, protects the tree, and every
 * large-build worktree becomes permanently unreapable — the immortality this
 * module's docblock exists to prevent. The timeout bounds the other direction:
 * a wedged git must not stall the sweep indefinitely.
 */
const PROBE_EXEC_OPTS = { maxBuffer: 64 * 1024 * 1024, timeout: 10_000 } as const;

/** Why the probe says a tree must be preserved. */
export type IgnoredProbeVerdict =
  | { protect: false }
  /** Found an ignored entry a rebuild would not restore. */
  | { protect: true; because: 'non-rebuildable-entry' }
  /**
   * git itself failed, so the answer is unknown and we protect on principle.
   * Distinguished from a real find so callers can SAY SO: a silent protect here
   * is indistinguishable from a genuine one and hides a permanent leak.
   */
  | { protect: true; because: 'git-failed'; detail: string };

/** True when `relPath` is ignored output a rebuild would restore. */
export function isRebuildableIgnoredEntry(relPath: string): boolean {
  return classifyIgnoredEntry(relPath) !== 'protected';
}

/**
 * Ignored entries git reports for the worktree, or `undefined` when git failed.
 * `scopePath` restricts the walk to one directory and expands it per-file
 * (`--untracked-files=all`) instead of collapsing it to a single line.
 */
async function readIgnoredEntries(
  execFile: ExecFileFn,
  worktreePath: string,
  scopePath?: string,
): Promise<{ entries: string[] } | { failure: string }> {
  const args = [
    ...GIT_LITERAL_PATHS,
    '-C', worktreePath,
    'status', '--porcelain', '--ignored',
  ];
  if (scopePath !== undefined) args.push('--untracked-files=all', '--', scopePath);
  try {
    const { stdout } = await execFile('git', args, PROBE_EXEC_OPTS);
    return {
      entries: stdout
        .split('\n')
        .filter((line) => line.startsWith('!!'))
        .map((line) => line.slice(2).trim())
        .filter((entry) => entry !== ''),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { failure: scopePath === undefined ? detail : `expanding ${scopePath}: ${detail}` };
  }
}

/**
 * Expand ONE build-output directory and report whether it hides local state a
 * rebuild would not restore.
 *
 * Contract: the expansion is deliberately non-recursive — nested results are
 * classified, never expanded again. That bounds the cost to a single extra git
 * call per inspectable directory and removes any chance of a cycle when git
 * echoes the collapsed directory back in the scoped output.
 */
async function inspectableDirHidesLocalState(
  execFile: ExecFileFn,
  worktreePath: string,
  dirEntry: string,
): Promise<IgnoredProbeVerdict> {
  const nested = await readIgnoredEntries(execFile, worktreePath, dirEntry);
  if ('failure' in nested) {
    return { protect: true, because: 'git-failed', detail: nested.failure };
  }
  for (const entry of nested.entries) {
    if (entry === dirEntry) continue; // git echoed the directory — no new information
    if (classifyIgnoredEntry(entry) === 'protected') {
      return { protect: true, because: 'non-rebuildable-entry' };
    }
  }
  return { protect: false };
}

/**
 * True when the worktree holds at least one ignored entry that a rebuild would
 * NOT restore — i.e. removing the checkout would destroy something the user
 * cannot get back.
 *
 * The top-level call uses `--ignored` in its default (traditional) mode on
 * purpose: it collapses an ignored DIRECTORY into a single `!! node_modules/`
 * line instead of listing every file beneath it, which keeps this cheap on a
 * populated worktree. Only directories classified `inspectable` — small build
 * output, not dependency trees — pay for a second, scoped call.
 */
export async function probeNonRebuildableIgnoredFiles(
  execFile: ExecFileFn,
  worktreePath: string,
): Promise<IgnoredProbeVerdict> {
  const top = await readIgnoredEntries(execFile, worktreePath);
  // Unreadable → never force-remove on a guess.
  if ('failure' in top) return { protect: true, because: 'git-failed', detail: top.failure };
  for (const entry of top.entries) {
    const verdict = classifyIgnoredEntry(entry);
    if (verdict === 'protected') return { protect: true, because: 'non-rebuildable-entry' };
    if (verdict === 'inspectable' && entry.endsWith('/')) {
      const nested = await inspectableDirHidesLocalState(execFile, worktreePath, entry);
      if (nested.protect) return nested;
    }
  }
  return { protect: false };
}

/**
 * Boolean form, kept as the default surface: most callers only need "may I
 * remove this?" and collapsing the verdict keeps their code honest about
 * failing safe. Use `probeNonRebuildableIgnoredFiles` when the caller can
 * REPORT why, so a protect-on-failure is not silent.
 */
export async function hasNonRebuildableIgnoredFiles(
  execFile: ExecFileFn,
  worktreePath: string,
): Promise<boolean> {
  return (await probeNonRebuildableIgnoredFiles(execFile, worktreePath)).protect;
}
