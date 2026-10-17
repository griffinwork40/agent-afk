/**
 * The OS temp ("scratch") directories — the single list shared by the typed
 * write-tool containment check (`computeContainment` in `_cwd-utils.ts`) and
 * the bash handler's advisory path scan (`bash-scan-exempt.ts`).
 *
 * Invariant (threat model): write-root confinement for forks is ACCIDENT
 * PREVENTION ("do not scribble on another worktree / the main checkout"), not a
 * security boundary (see `hooks/path-approval-hook.ts` header). The temp dir is
 * outside every worktree yet holds no credentials and is where every
 * well-behaved tool puts scratch files. Denying it there was pure friction:
 * ~300 fork write denials in one month of witness telemetry, dominated by
 * `/tmp/commit-msg.txt` and `/tmp/pr-body*.md`, each one a retry loop. A fork's
 * own bash children already write there freely (their `TMPDIR` is a per-session
 * dir under `/tmp/afk-<uid>`, see `session/session-tmpdir.ts`), so the typed
 * tools refusing it protected nothing.
 *
 * Invariant (what this does NOT relax): the scratch allowance is a containment
 * verdict only. The credential write-denylist (`write-denylist.ts`) still runs
 * after containment in every write handler, and the candidate path is compared
 * AFTER realpath resolution, so `/tmp/x -> ~/.ssh` resolves to `~/.ssh/...`,
 * which is not under a scratch root and stays denied. Dangling links are
 * re-checked against their target by `assertWriteTargetContained`.
 *
 * @module agent/tools/handlers/scratch-roots
 */

import os from 'os';
import path from 'path';
import { realpathSync } from 'fs';

/** POSIX scratch dirs that exist (or are aliases) on macOS and Linux. */
const POSIX_SCRATCH_LITERALS: readonly string[] = [
  '/tmp',
  '/private/tmp',
  '/var/tmp',
  '/private/var/tmp',
];

function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
}

function dedupe(list: ReadonlyArray<string | undefined>): string[] {
  return [...new Set(list.filter((r): r is string => r !== undefined && r !== '' && r !== '/'))];
}

let lexicalCache: readonly string[] | undefined;
let realCache: readonly string[] | undefined;

/**
 * Scratch roots in LEXICAL form for the bash scan: the POSIX literals plus
 * `os.tmpdir()` and its realpath. The POSIX literals are kept on every platform
 * because bash runs Git Bash / MSYS on win32, where `/tmp` is real.
 * Computed once per process (`os.tmpdir()` is fixed at process start).
 */
export function lexicalScratchRoots(): readonly string[] {
  if (lexicalCache !== undefined) return lexicalCache;
  const tmp = os.tmpdir();
  lexicalCache = dedupe([...POSIX_SCRATCH_LITERALS, tmp, safeRealpath(tmp)]);
  return lexicalCache;
}

/**
 * Scratch roots in REALPATH form for typed-tool containment, compared against
 * an already-realpath'd candidate. `os.tmpdir()` (both spellings) everywhere;
 * the POSIX literals only off win32, where a host-resolved `/tmp` would name a
 * drive-relative `X:\tmp` that is not a temp dir at all. Literals that do not
 * exist on this host are dropped rather than kept unresolved.
 */
export function realScratchRoots(): readonly string[] {
  if (realCache !== undefined) return realCache;
  const tmp = os.tmpdir();
  const literals = process.platform === 'win32' ? [] : POSIX_SCRATCH_LITERALS;
  realCache = dedupe([
    path.isAbsolute(tmp) ? tmp : undefined,
    safeRealpath(tmp),
    ...literals.map((p) => safeRealpath(p)),
  ]);
  return realCache;
}

/**
 * Whether an already-realpath'd absolute path lies at or inside a scratch root.
 *
 * Contract: `realAbs` MUST already be symlink-resolved (the caller's
 * `realpathSafe`); this function does no resolution itself, which is exactly
 * what keeps a temp-dir symlink into a credential dir out of the allowance.
 */
export function isWithinScratchRoot(realAbs: string): boolean {
  for (const root of realScratchRoots()) {
    const rel = path.relative(root, realAbs);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  }
  return false;
}

/** Test-only: drop both caches (e.g. after stubbing `os.tmpdir`). */
export function _resetScratchRootsCacheForTests(): void {
  lexicalCache = undefined;
  realCache = undefined;
}

/**
 * Test-only: pin the typed-tool scratch roots (`[]` disables the allowance).
 * Suites that use an `os.tmpdir()` mkdtemp dir as their "outside every root"
 * location call this so they keep exercising granted-root containment rather
 * than the temp-dir policy. Undo with {@link _resetScratchRootsCacheForTests}.
 */
export function _setRealScratchRootsForTests(roots: readonly string[]): void {
  realCache = roots.slice();
}
