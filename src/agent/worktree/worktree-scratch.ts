/**
 * The sanctioned scratch directory for agents working in an afk-managed
 * worktree: `.afk-scratch/` at the worktree root.
 *
 * Contract: agents need somewhere to put throwaway files (commit message
 * bodies, PR bodies, issue comments). Anywhere else in the tree such a file is
 * either untracked (so teardown sees a dirty tree and preserves-and-locks it)
 * or gitignored but unrecognised (so the ignored-file probe reports
 * `ignored-local-state`, a lock that is never auto-released). This module
 * makes `.afk-scratch/` invisible to `git status` in ANY repository, without
 * touching a tracked file, by appending one anchored pattern to
 * `<git-common-dir>/info/exclude` — the per-repo exclude file every linked
 * worktree of that repo shares. The ignored-file probe separately classifies
 * the directory as rebuildable (`worktree-ignored-patterns.ts`).
 *
 * Invariant: {@link ensureScratchExcluded} never throws and never deletes
 * anything. On any failure it returns `false` and the caller proceeds exactly
 * as before this module existed: a tree holding scratch files is then simply
 * preserved and locked, the pre-existing fail-safe behaviour.
 *
 * @module agent/worktree/worktree-scratch
 */

import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { atomicWriteFileAsync } from '../../utils/atomic-write.js';
import { debugLog } from '../../utils/debug.js';
import { errorMessage } from '../../utils/errors.js';

/** Directory name, relative to the worktree root. */
export const AFK_SCRATCH_DIR = '.afk-scratch';

/**
 * The exclude pattern. Leading slash anchors it to the worktree root, so a
 * nested `sub/.afk-scratch/` is NOT excluded and still reads as dirty.
 */
export const AFK_SCRATCH_EXCLUDE_PATTERN = `/${AFK_SCRATCH_DIR}/`;

/** Minimal git runner; both worktree ExecFileFn shapes satisfy it. */
export type ScratchGitRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/** True when an exclude file's content already ignores the scratch dir. */
export function excludeHasScratchEntry(content: string): boolean {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === AFK_SCRATCH_EXCLUDE_PATTERN || line === `${AFK_SCRATCH_DIR}/`);
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
 * Idempotently add `/.afk-scratch/` to `<git-common-dir>/info/exclude`.
 *
 * `anyPath` may be the main checkout or any linked worktree: all of them
 * resolve to the same common dir. Returns `true` when the entry is present
 * after the call (already there or just written), `false` on any failure.
 */
export async function ensureScratchExcluded(
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
    if (excludeHasScratchEntry(content)) return true;
    const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    const next = `${content}${sep}# afk: agent scratch dir, deleted with the worktree\n${AFK_SCRATCH_EXCLUDE_PATTERN}\n`;
    await atomicWriteFileAsync(excludePath, next, { mode: 0o644 });
    return true;
  } catch (err) {
    debugLog('[worktree-scratch] could not ensure .afk-scratch/ exclude:', errorMessage(err));
    return false;
  }
}
