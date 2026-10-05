/**
 * Exemptions for the bash handler's ADVISORY path-escape scan.
 *
 * The scan (`scanPathsBestEffort` in `bash.ts`) warns once per handler when a
 * command references an absolute or home-relative path outside the session's
 * write roots. Two families of path are outside every worktree yet are not an
 * "escape the worktree" risk, and flagging them produced almost all of the
 * scan's output in practice (dominated by `2>/dev/null` redirects and `/tmp`
 * scratch files):
 *
 *   - Character-device SINKS/SOURCES (`/dev/null`, `/dev/stderr`, `/dev/fd/N`,
 *     …). Deliberately an explicit allowlist, NOT the whole `/dev/` prefix:
 *     block devices such as `/dev/disk2` stay flagged.
 *   - The shared SCRATCH directories (`/tmp`, `/private/tmp`, `/var/tmp`, and
 *     `os.tmpdir()` plus its realpath — `/var/folders/…/T` on macOS).
 *
 * Invariant: this module only SUPPRESSES an advisory warning. It never widens
 * what the typed file tools may read or write — `resolveAndContain` in
 * `_cwd-utils.ts` does not consult it — and the scan itself never blocks
 * execution. Worse than noise, a false positive consumed the scan's one-time
 * latch, silencing a later genuine escape (e.g. a `cd` into the main checkout)
 * for the rest of the session; exempting benign paths keeps that latch for the
 * references worth seeing. See `docs/decisions/0001-bash-tool-path-containment.md`.
 *
 * @module agent/tools/handlers/bash-scan-exempt
 */

import os from 'os';
import path from 'path';
import { realpathSync } from 'fs';
import { extractCandidatePaths } from './_cwd-utils.js';

/** Device nodes that are pure sinks/sources — never a write-escape target. */
const DEVICE_SINKS: ReadonlySet<string> = new Set([
  '/dev/null',
  '/dev/zero',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
  '/dev/random',
  '/dev/urandom',
]);

/** Matches `/dev/fd/<n>` (process-substitution and fd-duplication paths). */
const DEV_FD_RE = /^\/dev\/fd\/\d+$/;

function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

let scratchRootsCache: readonly string[] | undefined;

/**
 * The scratch roots, computed once per process: `os.tmpdir()` is fixed at
 * process start, so caching removes a realpath syscall from every bash call.
 */
function scratchRoots(): readonly string[] {
  if (scratchRootsCache !== undefined) return scratchRootsCache;
  const tmp = os.tmpdir();
  const candidates = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', tmp, safeRealpath(tmp)];
  scratchRootsCache = [...new Set(candidates.filter((r): r is string => r !== undefined && r !== '/'))];
  return scratchRootsCache;
}

/** Test-only: drop the cached scratch roots (e.g. after stubbing `os.tmpdir`). */
export function _resetScanExemptCacheForTests(): void {
  scratchRootsCache = undefined;
}

/**
 * Lexically normalize a scan candidate, choosing path semantics by its SHAPE
 * rather than by host platform.
 *
 * Invariant: a candidate beginning with `/` is a POSIX path even on win32 —
 * the bash tool runs Git Bash / MSYS there, where `/dev/null` and `/tmp` are
 * real. Host `path.resolve` would turn `/dev/null` into `D:\dev\null`, which
 * never matches `DEVICE_SINKS` or the POSIX scratch roots, so every
 * `2>/dev/null` fired the advisory again (issue #703 Windows leg). Native
 * win32 paths (`C:\…`) keep host semantics so they still match `os.tmpdir()`.
 */
function normalizeCandidate(absPath: string): { normalized: string; sep: string } {
  if (absPath.startsWith('/')) return { normalized: path.posix.resolve(absPath), sep: '/' };
  return { normalized: path.resolve(absPath), sep: path.sep };
}

/**
 * Whether an ABSOLUTE path candidate from the bash scan is benign and must not
 * be reported as a writeRoots escape.
 *
 * The path is lexically normalized first, so a traversal such as
 * `/tmp/../etc/hosts` resolves to `/etc/hosts` and is NOT exempt.
 *
 * @param absPath - An absolute path (the scan expands `~` before calling).
 * @returns `true` when the path is a known device sink or lies inside a
 *   shared scratch directory; `false` otherwise (including relative input).
 */
export function isBashScanExemptPath(absPath: string): boolean {
  if (!path.isAbsolute(absPath)) return false;
  const { normalized, sep } = normalizeCandidate(absPath);
  if (DEVICE_SINKS.has(normalized) || DEV_FD_RE.test(normalized)) return true;
  return scratchRoots().some(
    (root) => normalized === root || normalized.startsWith(root + sep),
  );
}

/**
 * The path candidates the bash scan should check against write roots: every
 * absolute / home-relative token from {@link extractCandidatePaths}, with `~`
 * and `~/…` expanded to `home` (so `wouldBeRestricted`, which anchors
 * non-absolute input to `resolveBase`, cannot mis-resolve them as in-root),
 * minus anything {@link isBashScanExemptPath} deems benign.
 *
 * @param command - The raw bash command string.
 * @param home - The home directory used for `~` expansion (`os.homedir()`).
 * @returns Absolute candidate paths, in first-seen order.
 */
export function scanCandidatePaths(command: string, home: string): string[] {
  const out: string[] = [];
  for (const candidate of extractCandidatePaths(command)) {
    const expanded =
      candidate === '~' ? home : candidate.startsWith('~/') ? home + candidate.slice(1) : candidate;
    if (!isBashScanExemptPath(expanded)) out.push(expanded);
  }
  return out;
}
