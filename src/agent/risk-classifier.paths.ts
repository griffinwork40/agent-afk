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
import { getAfkHome, getAfkStateDir, getAgentFrameworkDir } from '../paths.js';
import { sessionTmpdirRoot } from './session/session-tmpdir.js';
import { pathIsWithin } from './tools/fs-case.js';
import type { RiskContext, RiskVerdict } from './risk-classifier.js';

/** Symlink hops followed for a dangling link before giving up (matches ELOOP
 *  and `MAX_LINK_HOPS` in tools/handlers/write-file.atomic.ts). */
const MAX_LINK_HOPS = 40;

/**
 * Cache key combines os.tmpdir() and sessionTmpdirRoot() so any change to
 * either (TMPDIR env var or test override) busts the cache. We do NOT cache
 * when any candidate was absent at probe time — the session root is created
 * lazily on first shell spawn, so a missing dir must be re-checked next call.
 * A cache hit is never trusted blindly: every cached root is re-validated (see
 * `getTempRoots`), so the cache only saves the realpath + candidate probing.
 */
let tempRootsCache:
  | { key: string; roots: readonly string[]; complete: boolean }
  | undefined;

/**
 * Pure predicate: is `st` a directory that no other local user can write into?
 *
 * Rules (applied in order):
 *   1. Must be a real directory (not a symlink).
 *   2. On POSIX when `uid` is defined: must be owned by `uid`.
 *   3. On win32 (`platform === 'win32'`): mode bits are meaningless (NTFS uses
 *      ACLs), so the mode check is skipped.
 *   4. On POSIX: `(mode & 0o077) === 0` — no group or other access at all.
 *      Write bits alone are not enough: a traversable 0755 root lets another
 *      user reach a 0777 subdirectory a child created inside it and swap a
 *      leaf symlink there between gate and write.
 *
 * The predicate is PURE: it takes a synthetic-stat-shaped object, a uid, and a
 * platform string, so it can be unit-tested on any host without touching the
 * filesystem or branching on the host platform.
 *
 * @param st   Stat-shaped object (from lstatSync or synthetic for testing).
 * @param uid  process.getuid() result — undefined on win32.
 * @param platform  process.platform value.
 */
export function isPrivateTempRoot(
  st: { isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number },
  uid: number | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (!st.isDirectory() || st.isSymbolicLink()) return false;
  if (uid !== undefined && st.uid !== uid) return false;
  if (platform === 'win32') return true;
  return (st.mode & 0o077) === 0;
}

/** Re-check one already-admitted (realpath'd) root; any lstat error → false. */
function isStillPrivate(
  root: string,
  uid: number | undefined,
  platform: NodeJS.Platform,
): boolean {
  try {
    return isPrivateTempRoot(lstatSync(root), uid, platform);
  } catch {
    return false;
  }
}

/**
 * Realpath'd private temp roots, ordered: session root first, then os.tmpdir().
 *
 * Invariant: only directories no other local user can write into are included.
 *   - The per-process session root (`sessionTmpdirRoot()`, typically
 *     `/tmp/afk-<uid>` on darwin or `<os.tmpdir()>/afk-<uid>` elsewhere) is
 *     included when lstat shows a real directory owned by this process's uid
 *     with no group/other permission bits (on POSIX).
 *   - `os.tmpdir()` is included only when `(mode & 0o077) === 0` on POSIX
 *     (macOS per-user /var/folders/…/T is 0700; Linux /tmp 1777 is excluded).
 *     On win32 (per-user profile temp; mode bits meaningless) it is always
 *     included.
 *   - Shared world-writable dirs (Linux /tmp, 0o1777) are never roots.
 *     The gate-time symlink check cannot close a write-time TOCTOU race;
 *     another local user can pre-create a directory and swap a path to ~/.bashrc
 *     between gate and write.
 *   - A root whose realpath fails is skipped (fail closed: no carve-out).
 *
 * Cache: keyed on `os.tmpdir() + sessionTmpdirRoot()`. When any candidate was
 * absent at probe time the result is NOT cached, so the session root (created
 * lazily on first shell spawn) is picked up on the next call.
 *
 * Invariant: a cached root is re-validated (lstat + isPrivateTempRoot) on
 * every call before it is returned. In a long-running daemon a tmp reaper can
 * delete an idle root and another local user can re-create it with loose
 * permissions; a trusted cache would keep admitting that path. Any failed
 * re-check discards the cache and re-probes from scratch.
 */
export function getTempRoots(): readonly string[] {
  const tmp = os.tmpdir();
  const sessRoot = sessionTmpdirRoot();
  const cacheKey = tmp + '\0' + sessRoot;
  const uid: number | undefined =
    typeof process.getuid === 'function' ? process.getuid() : undefined;
  const platform = process.platform;

  if (
    tempRootsCache &&
    tempRootsCache.key === cacheKey &&
    tempRootsCache.complete &&
    tempRootsCache.roots.every((r) => isStillPrivate(r, uid, platform))
  ) {
    return tempRootsCache.roots;
  }

  const roots: string[] = [];
  let allPresent = true;

  // (a) Session root first — private per-uid directory.
  try {
    const st = lstatSync(sessRoot);
    if (isPrivateTempRoot(st, uid, platform)) {
      roots.push(realpathSync(sessRoot));
    }
  } catch {
    // Dir does not exist yet (lazy creation) — skip but do not negatively cache.
    allPresent = false;
  }

  // (b) os.tmpdir() — included only when private (or win32).
  try {
    const real = realpathSync(tmp);
    const st = lstatSync(real);
    if (isPrivateTempRoot(st, uid, platform)) {
      if (!roots.includes(real)) roots.push(real);
    }
  } catch {
    allPresent = false;
  }

  tempRootsCache = { key: cacheKey, roots, complete: allPresent };
  return roots;
}

/** Boundary-safe containment on realpath'd values (`<tmp>-evil/x` is NOT inside). */
function isInsideTempRoot(p: string, roots: readonly string[]): boolean {
  return roots.some((root) => p === root || p.startsWith(root + path.sep));
}

function errCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : undefined;
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
      return { level: 'high', reason: `write-denylist: ${resolved} is under ${blocked}`, category: 'credential-path' };
    }
  }
  // .git/ directory — writes to the git object store are almost always wrong.
  if (resolvedNorm.includes('/.git/')) {
    return { level: 'high', reason: `git-dir: ${resolved} is inside .git/`, category: 'credential-path' };
  }
  return undefined;
}

/**
 * Exported for portable unit testing across path implementations (e.g.
 * `path.win32`). Returns true when `target` resolves OUTSIDE `root` —
 * either a `..`-relative escape or, on win32, an absolute path on a
 * different drive (`path.relative` returns an absolute path in that case).
 */
export function isOutsideRoot(
  root: string,
  target: string,
  pathImpl: Pick<typeof path, 'relative' | 'isAbsolute'> = path,
): boolean {
  const rel = pathImpl.relative(root, target);
  return rel.startsWith('..') || pathImpl.isAbsolute(rel);
}

/**
 * All independently relocatable AFK state roots, or `null` if any is invalid.
 * Resolve through existing ancestors even when a root has not been created.
 * Unknown root → fail closed: no private-temp carve-out may be granted.
 *
 * Invariant: if ANY root fails to resolve, the entire function returns `null`
 * and the private-temp carve-out is denied for the write. These roots are
 * EXCLUSIONS — we must be able to prove the write target is outside all of
 * them. A partial list creates a security hole: if AFK_FRAMEWORK_DIR resolves
 * to a temp path but we cannot check it, we might erroneously allow a write
 * into it. The cost of fail-closed is only a false-positive denial; the cost
 * of partial roots is a false-negative permission grant.
 *
 * This deliberately differs from `derivedAfkHomeWriteEntries()` in
 * write-denylist.ts, which builds an additive block list — dropping one entry
 * there is safe (the write is merely un-blocked by that entry; other entries
 * still apply). Here, dropping one exclusion root silently opens a hole.
 */
function afkStateRootsResolved(): readonly string[] | null {
  try {
    return [getAfkHome(), getAfkStateDir(), getAgentFrameworkDir()].map(safeRealpath);
  } catch {
    return null;
  }
}

/**
 * True when a write that escapes the workspace may still proceed because both
 * the named path and the writer's final target sit inside a private temp root,
 * the final target is neither denylisted nor inside `.git/`, and the target
 * is NOT inside any AFK state root (home, state tier, or framework tier).
 * These must not be silently writable via a temp-root carve-out.
 */
function isSafeTempWrite(abs: string, resolved: string): boolean {
  // Invariant: re-validate cached roots once per write classification, never once
  // per process. Both containment checks use the same fail-closed snapshot.
  const tempRoots = getTempRoots();
  if (!isInsideTempRoot(resolved, tempRoots)) return false;
  const target = finalWriteTarget(abs);
  if (!isInsideTempRoot(target, tempRoots)) return false;
  if (hardBlock(target) !== undefined) return false;
  // AFK state under a temp root must not become writable through the carve-out.
  // Keep the original exact comparison additive; the case-aware check only
  // excludes more, including missing leaves on case-insensitive volumes.
  const roots = afkStateRootsResolved();
  if (roots === null) return false;
  // Fast path: exact match or literal prefix skips the isCaseInsensitiveFs
  // probe on the common hot path. pathIsWithin subsumes both checks, so this
  // only changes performance, not correctness.
  return !roots.some((root) =>
    target === root || target.startsWith(root + path.sep) || pathIsWithin(target, root));
}

/** Classify one write target path. */
export function classifyFilePath(filePath: string, ctx: RiskContext): RiskVerdict {
  if (!filePath) return { level: 'safe', category: 'workspace-write' };

  const abs = path.resolve(ctx.cwd, filePath);
  const resolved = safeRealpath(abs);

  // Denylist (~/.ssh, /etc, …) and .git/ always win, temp dir included.
  const blocked = hardBlock(resolved);
  if (blocked) return blocked;

  // Workspace boundary escape. Only the AFK gate passes workspaceRoot.
  if (ctx.workspaceRoot !== undefined) {
    const realRoot = safeRealpath(ctx.workspaceRoot);
    // On win32, path.relative returns an absolute path when root and target
    // are on different drives; isOutsideRoot treats that as an escape too.
    // Invariant: private temp roots are sanctioned scratch areas in AFK mode,
    // so a temp write is not an escape. Checked after denylist/.git (above) and
    // on the writer's final target (finalWriteTarget), so a temp symlink cannot
    // carry the bytes outside tmp.
    if (isOutsideRoot(realRoot, resolved) && !isSafeTempWrite(abs, resolved)) {
      return { level: 'high', reason: `workspace-escape: ${resolved} is outside ${realRoot}`, category: 'workspace-escape' };
    }
  }

  // node_modules — usually unintentional; not catastrophic.
  if (toSlash(resolved).includes('/node_modules/')) {
    return { level: 'medium', reason: `node-modules: ${resolved}`, category: 'workspace-write' };
  }

  return { level: 'safe', category: 'workspace-write' };
}

/**
 * patch_apply atomically writes multiple files; classify by the highest-risk
 * path across the entire changes array. An empty changes array is safe.
 */
export function classifyPatchApply(input: unknown, ctx: RiskContext): RiskVerdict {
  const obj = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const changes = Array.isArray(obj['changes']) ? obj['changes'] : [];
  let highest: RiskVerdict = { level: 'safe', category: 'workspace-write' };
  for (const change of changes) {
    if (typeof change !== 'object' || change === null) continue;
    const p = (change as Record<string, unknown>)['path'];
    const verdict = classifyFilePath(typeof p === 'string' ? p : '', ctx);
    if (verdict.level === 'high') return verdict;
    if (verdict.level === 'medium' && highest.level === 'safe') highest = verdict;
  }
  return highest;
}
