/**
 * Contract: the sanctioned scratch directory for agents working in an afk-managed
 * worktree: `.afk-scratch/` at the worktree root.
 *
 * Contract: agents need somewhere to put throwaway files (commit message
 * bodies, PR bodies, issue comments). Anywhere else in the tree such a file is
 * either untracked (so teardown sees a dirty tree and preserves-and-locks it)
 * or gitignored but unrecognised (so the ignored-file probe reports
 * `ignored-local-state`, a lock that is never auto-released). This module
 * makes `.afk-scratch/` invisible to `git status` in ANY repository, without
 * touching a tracked file, by appending one anchored pattern to
 * `<git-common-dir>/info/exclude`, the per-repo exclude file every linked
 * worktree of that repo shares. The ignored-file probe only treats the root
 * directory as disposable when this worktree's meta records the creation-time
 * opt-in. Shared exclusion alone never sanctions another worktree's files.
 *
 * The same file also carries `/.afk-worktree-meta.json`, afk's own bookkeeping
 * file at every managed worktree root. A repository that does not gitignore it
 * (most do not) saw every fresh worktree as dirty, so teardown preserved and
 * locked trees that held nothing but that file. The probe already classifies
 * it as rebuildable; only the exclude entry was missing. Unlike the scratch
 * dir, this entry is not gated on the opt-in: it applies to every tree.
 *
 * Invariant: {@link ensureAfkExcludes} never throws and never deletes
 * anything. On any failure it returns `false` and the caller proceeds exactly
 * as before this module existed: a tree holding scratch files is then simply
 * preserved and locked, the pre-existing fail-safe behaviour.
 *
 * @module agent/worktree/worktree-scratch
 */

import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { debugLog } from '../../utils/debug.js';
import { errorMessage } from '../../utils/errors.js';

/** Directory name, relative to the worktree root. */
export const AFK_SCRATCH_DIR = '.afk-scratch';

/**
 * The exclude pattern. Leading slash anchors it to the worktree root, so a
 * nested `sub/.afk-scratch/` is NOT excluded and still reads as dirty.
 */
export const AFK_SCRATCH_EXCLUDE_PATTERN = `/${AFK_SCRATCH_DIR}/`;

/** afk's per-worktree bookkeeping file, relative to the worktree root. */
export const AFK_META_FILE = '.afk-worktree-meta.json';

/** Root-anchored exclude pattern for {@link AFK_META_FILE}. */
export const AFK_META_EXCLUDE_PATTERN = `/${AFK_META_FILE}`;

/**
 * Every entry afk keeps in the shared exclude file. `unanchored` is the
 * broader spelling a user may already have written; it counts as present.
 */
const AFK_EXCLUDE_ENTRIES: readonly { pattern: string; unanchored: string }[] = [
  { pattern: AFK_SCRATCH_EXCLUDE_PATTERN, unanchored: `${AFK_SCRATCH_DIR}/` },
  { pattern: AFK_META_EXCLUDE_PATTERN, unanchored: AFK_META_FILE },
];

/** Minimal git runner; both worktree ExecFileFn shapes satisfy it. */
export type ScratchGitRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Per-process cache: once we've read a worktree's meta, the result is stable
 * for the lifetime of the process (the file is only written at worktree-create
 * time). Cache key is the normalised absolute worktree root.
 */
const _scratchDisposableCache = new Map<string, boolean>();

/**
 * Missing, unreadable, or malformed metadata never sanctions scratch deletion.
 *
 * Uses a forward-slash join so the path fed to `fs.readFile` is correct even
 * when `worktreePath` was produced by `extractWorktreePath` (which normalises
 * Windows backslashes to forward slashes). Native `path.join` on Windows would
 * re-interpret a POSIX-style path and may produce a wrong result.
 */
export async function isScratchDisposable(worktreePath: string): Promise<boolean> {
  const cached = _scratchDisposableCache.get(worktreePath);
  if (cached !== undefined) return cached;
  try {
    // Use forward-slash concatenation so the path is correct even when
    // worktreePath was normalised to POSIX separators by extractWorktreePath.
    const metaPath = worktreePath.endsWith('/') ? `${worktreePath}${AFK_META_FILE}` : `${worktreePath}/${AFK_META_FILE}`;
    const meta: unknown = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
    const result = typeof meta === 'object' && meta !== null && !Array.isArray(meta) &&
      'scratchDisposable' in meta && meta.scratchDisposable === true;
    _scratchDisposableCache.set(worktreePath, result);
    return result;
  } catch (err) {
    debugLog('[worktree-scratch] isScratchDisposable: could not read meta for', worktreePath, '—', errorMessage(err));
    return false;
  }
}

/** The afk exclude patterns an exclude file's content does not yet carry. */
export function missingAfkExcludes(content: string): string[] {
  const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()));
  return AFK_EXCLUDE_ENTRIES
    .filter((entry) => !lines.has(entry.pattern) && !lines.has(entry.unanchored))
    .map((entry) => entry.pattern);
}

/** True when an exclude file's content already ignores the scratch dir. */
export function excludeHasScratchEntry(content: string): boolean {
  return !missingAfkExcludes(content).includes(AFK_SCRATCH_EXCLUDE_PATTERN);
}

/** True when an exclude file's content already ignores the meta file. */
export function excludeHasMetaEntry(content: string): boolean {
  return !missingAfkExcludes(content).includes(AFK_META_EXCLUDE_PATTERN);
}

/** Absolute git common dir for any path inside the repo, or undefined. */
async function resolveCommonDir(execFile: ScratchGitRunner, anyPath: string): Promise<string | undefined> {
  const out = await execFile('git', ['--no-optional-locks', '-C', anyPath, 'rev-parse', '--git-common-dir']);
  const raw = out.stdout.trim();
  if (raw === '') return undefined;
  const abs = isAbsolute(raw) ? raw : resolve(anyPath, raw);
  // Guard against a runner that answered with something other than a git
  // dir: only ever write beneath a directory that already exists.
  const stat = await fs.stat(abs);
  return stat.isDirectory() ? abs : undefined;
}

/**
 * Idempotently add afk's entries (`/.afk-scratch/` and
 * `/.afk-worktree-meta.json`) to `<git-common-dir>/info/exclude`.
 *
 * `anyPath` may be the main checkout or any linked worktree: all of them
 * resolve to the same common dir. Returns `true` when every entry is present
 * after the call (already there or just appended), `false` on any failure.
 */
export async function ensureAfkExcludes(
  execFile: ScratchGitRunner,
  anyPath: string,
): Promise<boolean> {
  try {
    const commonDir = await resolveCommonDir(execFile, anyPath);
    if (commonDir === undefined) return false;
    const excludePath = join(commonDir, 'info', 'exclude');
    let content = '';
    try {
      content = await fs.readFile(excludePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const missing = missingAfkExcludes(content);
    if (missing.length === 0) return true;
    // Always lead with a newline: the read above can be stale, and another
    // writer may have appended a line with no trailing newline since. A blank
    // line in an exclude file is harmless; a glued `foo# afk: ...` is not.
    const addition = `\n# afk: managed-worktree scratch dir and bookkeeping file\n${missing.join('\n')}\n`;
    await fs.mkdir(dirname(excludePath), { recursive: true });
    // O_APPEND preserves lines another writer added after our read.
    await fs.appendFile(excludePath, addition, { mode: 0o644 });
    return true;
  } catch (err) {
    debugLog('[worktree-scratch] could not ensure afk exclude entries:', errorMessage(err));
    return false;
  }
}
