/**
 * Path-based risk rules for the risk classifier: `write_file` / `edit_file` /
 * `patch_apply` targets, including the system-temp-dir carve-out.
 *
 * Extracted from `risk-classifier.ts` (350-code-line ceiling); that module keeps
 * its public surface and re-uses these helpers.
 *
 * @module agent/risk-classifier.paths
 */

import os from 'os';
import path from 'path';
import { lstatSync, readlinkSync, realpathSync } from 'fs';
import { safeRealpath, getWriteDenylist } from './tools/handlers/write-denylist.js';
import type { RiskContext, RiskVerdict } from './risk-classifier.js';

/** Symlink hops followed for a dangling link before giving up (matches ELOOP
 *  and `MAX_LINK_HOPS` in tools/handlers/write-file.atomic.ts). */
const MAX_LINK_HOPS = 40;

/** Literal POSIX shared temp dir models commonly write to (`/tmp/x.py`). */
const POSIX_SHARED_TMP = '/tmp';

let tempRootsCache: { key: string; roots: readonly string[] } | undefined;

/**
 * Realpath'd system temp roots: `os.tmpdir()` plus, on POSIX, the shared
 * `/tmp` (on macOS `/private/tmp`, distinct from the per-user `os.tmpdir()`).
 *
 * Invariant: roots are harness-derived (OS + TMPDIR), never model-authored, so
 * the carve-out adds no new trust channel. A root whose realpath fails is
 * skipped (fail closed: no carve-out), and on win32 there is no `/tmp`.
 * Cached per `os.tmpdir()` value so a TMPDIR change is picked up.
 */
export function getTempRoots(): readonly string[] {
  const tmp = os.tmpdir();
  if (tempRootsCache && tempRootsCache.key === tmp) return tempRootsCache.roots;
  const candidates = process.platform === 'win32' ? [tmp] : [tmp, POSIX_SHARED_TMP];
  const roots: string[] = [];
  for (const c of candidates) {
    try {
      const real = realpathSync(c);
      if (!roots.includes(real)) roots.push(real);
    } catch {
      // Unresolvable root: no carve-out for it.
    }
  }
  tempRootsCache = { key: tmp, roots };
  return roots;
}

/** Boundary-safe containment on realpath'd values (`<tmp>-evil/x` is NOT inside). */
function isInsideTempRoot(p: string): boolean {
  return getTempRoots().some((root) => p === root || p.startsWith(root + path.sep));
}

function errCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : undefined;
}

/**
 * Synchronous mirror of `resolveWriteTarget` (tools/handlers/write-file.atomic.ts):
 * the path the writer's bytes will actually land on.
 *
 * Contract: `safeRealpath` does NOT follow a dangling leaf symlink, but the
 * writer does (it creates the link's final target). The temp carve-out must
 * judge the final target, or `<tmp>/x -> /somewhere/outside` would be rated
 * safe while the bytes land outside tmp. Any unexpected fs error returns the
 * path as-is; the caller then also requires it to be in a temp root.
 */
function finalWriteTarget(abs: string): string {
  try {
    return realpathSync(abs);
  } catch {
    // ENOENT (new file or dangling link) or a broken chain — walk by hand.
  }
  let current = abs;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    let isLink: boolean;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch (err) {
      if (errCode(err) === 'ENOENT') break;
      return current;
    }
    if (!isLink) break;
    try {
      current = path.resolve(path.dirname(current), readlinkSync(current));
    } catch {
      return current;
    }
  }
  return safeRealpath(current);
}

const toSlash = (p: string): string => p.split(path.sep).join('/');

/** Denylist / `.git/` verdict for an already-resolved absolute path. */
function hardBlock(resolved: string): RiskVerdict | undefined {
  const resolvedNorm = toSlash(resolved);
  for (const blocked of getWriteDenylist()) {
    const blockedNorm = toSlash(blocked);
    if (resolvedNorm === blockedNorm || resolvedNorm.startsWith(blockedNorm + '/')) {
      return { level: 'high', reason: `write-denylist: ${resolved} is under ${blocked}` };
    }
  }
  // .git/ directory — writes to the git object store are almost always wrong.
  if (resolvedNorm.includes('/.git/')) {
    return { level: 'high', reason: `git-dir: ${resolved} is inside .git/` };
  }
  return undefined;
}

/**
 * True when a write that escapes the workspace may still proceed because both
 * the named path and the writer's final target sit inside a system temp root
 * and the final target is neither denylisted nor inside `.git/`.
 */
function isSafeTempWrite(abs: string, resolved: string): boolean {
  if (!isInsideTempRoot(resolved)) return false;
  const target = finalWriteTarget(abs);
  if (!isInsideTempRoot(target)) return false;
  return hardBlock(target) === undefined;
}

/** Classify one write target path. */
export function classifyFilePath(filePath: string, ctx: RiskContext): RiskVerdict {
  if (!filePath) return { level: 'safe' };

  const abs = path.resolve(ctx.cwd, filePath);
  const resolved = safeRealpath(abs);

  // Denylist (~/.ssh, /etc, …) and .git/ always win, temp dir included.
  const blocked = hardBlock(resolved);
  if (blocked) return blocked;

  // Workspace boundary escape. Only the AFK gate passes workspaceRoot.
  if (ctx.workspaceRoot !== undefined) {
    const realRoot = safeRealpath(ctx.workspaceRoot);
    const rel = path.relative(realRoot, resolved);
    // Invariant: the system temp dir is a sanctioned scratch area in AFK mode,
    // so a temp write is not an escape. Checked after denylist/.git (above) and
    // on the writer's final target (finalWriteTarget), so a temp symlink cannot
    // carry the bytes outside tmp.
    if (rel.startsWith('..') && !isSafeTempWrite(abs, resolved)) {
      return { level: 'high', reason: `workspace-escape: ${resolved} is outside ${realRoot}` };
    }
  }

  // node_modules — usually unintentional; not catastrophic.
  if (toSlash(resolved).includes('/node_modules/')) {
    return { level: 'medium', reason: `node-modules: ${resolved}` };
  }

  return { level: 'safe' };
}

/**
 * patch_apply atomically writes multiple files; classify by the highest-risk
 * path across the entire changes array. An empty changes array is safe.
 */
export function classifyPatchApply(input: unknown, ctx: RiskContext): RiskVerdict {
  const obj = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const changes = Array.isArray(obj['changes']) ? obj['changes'] : [];
  let highest: RiskVerdict = { level: 'safe' };
  for (const change of changes) {
    if (typeof change !== 'object' || change === null) continue;
    const p = (change as Record<string, unknown>)['path'];
    const verdict = classifyFilePath(typeof p === 'string' ? p : '', ctx);
    if (verdict.level === 'high') return verdict;
    if (verdict.level === 'medium' && highest.level === 'safe') highest = verdict;
  }
  return highest;
}
