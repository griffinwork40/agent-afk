/**
 * Shared write-denylist utilities for file-writing tool handlers.
 *
 * Both `write_file` and `edit_file` write to the filesystem and must enforce
 * the same denylist. This module is the single source of truth so the two
 * handlers stay in sync automatically.
 *
 * Symlink safety: `path.resolve` normalises `.`/`..` segments but does NOT
 * dereference symlinks — a symlink `~/link → ~/.ssh` would bypass a denylist
 * entry for `~/.ssh`. We dereference via `fs.realpathSync` walking up the
 * parent chain until we find an existing ancestor, then resolve the remaining
 * tail against that real ancestor.
 *
 * @module agent/tools/handlers/write-denylist
 */

import { env } from '../../../config/env.js';
import { realpathSync } from 'fs';
import { dirname, resolve, join } from 'path';
import { homedir } from 'os';
import { getAfkHome, getAfkStateDir } from '../../../paths.js';
import { warnAfkHomeRejectedOnce } from '../afk-home-warn.js';
import { pathIsWithin } from '../fs-case.js';

/**
 * Paths that write_file / edit_file must never touch — credential stores,
 * system config, and platform secret directories. Each entry is matched
 * against the real (symlink-resolved) target path as a prefix.
 *
 * Override by setting AFK_WRITE_DENYLIST (colon-separated absolute paths)
 * in the environment — note that the built-in entries always apply on top
 * of any custom list; there is intentionally no way to remove them via env.
 */
export const BUILTIN_WRITE_DENYLIST: readonly string[] = [
  `${homedir()}/.ssh`,
  `${homedir()}/.aws`,
  `${homedir()}/.gnupg`,
  `${homedir()}/.config/gcloud`,
  '/etc',
  '/System',
  '/private/etc',
  '/usr/local/etc',
  // S4: AFK own credential/config tree — prevents model from overwriting its
  // own API key (afk.env), MCP registry (mcp.json), or session state.
  `${homedir()}/.afk/config`,
  `${homedir()}/.afk/state`,
  // S4: npm publish tokens and Docker registry credentials.
  `${homedir()}/.npmrc`,
  `${homedir()}/.docker/config.json`,
  // S4-win32: Windows credential/config trees. Gated on both process.platform
  // and the env var: on POSIX, USERPROFILE/APPDATA may be set in CI/Docker
  // but the backslash paths would resolve incorrectly — the platform guard
  // prevents those entries from being added on non-Windows systems.
  ...(process.platform === 'win32' && env.APPDATA
    ? [`${env.APPDATA}\\gcloud`, `${env.APPDATA}\\Docker`]
    : []),
  ...(process.platform === 'win32' && env.USERPROFILE
    ? [
        `${env.USERPROFILE}\\.ssh`,
        `${env.USERPROFILE}\\.aws`,
        `${env.USERPROFILE}\\.gnupg`,
      ]
    : []),
];

/**
 * Best-effort derived write-denylist entries for the `AFK_HOME`-relocated
 * config AND state dirs (`${getAfkHome()}/config`, `${getAfkHome()}/state`),
 * ADDITIVE alongside the hardcoded `${homedir()}/.afk/config` and
 * `${homedir()}/.afk/state` literals in {@link BUILTIN_WRITE_DENYLIST} (both
 * spellings are covered; de-duplicated by the caller when `AFK_HOME` is
 * unset). Mirrors BOTH existing AFK entries in the write denylist — unlike
 * the read denylist, `state` belongs here too (writes to session/todo/
 * transcript state are never legitimate for a model to perform directly).
 *
 * Invariant: the state tier is derived via `getAfkStateDir()`, NOT
 * `join(getAfkHome(), 'state')` alone. `AFK_STATE_DIR` relocates the ENTIRE
 * state tier INDEPENDENTLY of `AFK_HOME` (`paths.ts`: it returns `AFK_STATE_DIR`
 * verbatim when set and only falls back to `join(getAfkHome(), 'state')`
 * otherwise). Deriving the tier from `AFK_HOME` alone left an operator running
 * `AFK_STATE_DIR=/opt/state` with zero write protection on their real state
 * tier — the same env-relocation gap this module exists to close. Both
 * spellings are emitted; the caller's `new Set` collapses them when they
 * coincide.
 *
 * Invariant: the two derivations sit in SEPARATE `try` blocks so one malformed
 * env var cannot drop the other's entries. A single combined block would let a
 * bad `AFK_STATE_DIR` also discard the `config` entry it never influenced.
 *
 * `getAfkHome()` / `getAfkStateDir()` throw when their env var is set but not
 * absolute (or is `/`, see `paths.ts`). Caught and dropped here — a malformed
 * env var must never empty the credential floor; the hardcoded
 * `homedir()`-based entries still apply regardless. The throw is no longer
 * silent: {@link warnAfkHomeRejectedOnce} surfaces it once per process.
 *
 * The unresolved spellings feed {@link getWriteDenylist}'s memo, which keys on
 * `AFK_HOME` and `AFK_STATE_DIR` (alongside `AFK_WRITE_DENYLIST`). Real paths
 * are deliberately resolved after every cache lookup so a denylisted symlink
 * cannot be repointed around a previously resolved credential floor.
 */
function derivedAfkHomeWriteEntries(): string[] {
  const entries: string[] = [];
  try {
    const home = getAfkHome();
    entries.push(resolve(join(home, 'config')));
    entries.push(resolve(join(home, 'state')));
  } catch (err) {
    warnAfkHomeRejectedOnce(err);
  }
  try {
    entries.push(resolve(getAfkStateDir()));
  } catch (err) {
    warnAfkHomeRejectedOnce(err);
  }
  return entries;
}

// Invariant: AFK_HOME and AFK_STATE_DIR are BOTH part of the cache key below,
// alongside AFK_WRITE_DENYLIST. `derivedAfkHomeWriteEntries()` depends on all
// three (AFK_HOME via `getAfkHome()`, AFK_STATE_DIR via `getAfkStateDir()`
// independently — see the Invariant on that function above), so a runtime
// change to ANY of them must invalidate the memo, or a relocated AFK_HOME /
// AFK_STATE_DIR keeps serving the pre-relocation denylist — silently
// permitting writes to the real (now-uncovered) credential tree. Only
// unresolved entry construction is memoized: the realpath results must remain
// live because filesystem topology can change independently of the
// environment. Joined with U+0000 (mirrors read-denylist.ts's key), which
// cannot occur in any of the three values, so components can never collide
// into an ambiguous key.
let cached: { key: string; unresolved: readonly string[] } | undefined;

/**
 * Return the effective denylist (builtin + any user-supplied extras).
 * Entries are returned as real (symlink-resolved) absolute paths.
 *
 * @note AFK_WRITE_DENYLIST is split on `:` on POSIX and `;` on Windows
 * (matching Windows PATH convention, since Windows paths contain colons).
 * POSIX paths that themselves contain a colon (unusual, impossible on macOS
 * HFS+) will be mis-split; use a different separator character in that case.
 */
export function getWriteDenylist(): readonly string[] {
  const key = `${env.AFK_WRITE_DENYLIST ?? ''}\u0000${env.AFK_HOME ?? ''}\u0000${env.AFK_STATE_DIR ?? ''}`;
  if (!cached || cached.key !== key) {
    const extra = env.AFK_WRITE_DENYLIST;
    // On Windows, paths contain colons (C:\…) so use ';' as the separator
    // (matching Windows PATH convention); on POSIX, use ':'.
    const listSep = process.platform === 'win32' ? ';' : ':';
    const extras = extra
      ? extra
          .split(listSep)
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => {
            // Expand leading ~/ or ~\ (Windows backslash tilde) to homedir.
            if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
              return join(homedir(), p.slice(2));
            }
            return p;
          })
          .map((p) => resolve(p))
          .filter(Boolean)
      : [];
    cached = {
      key,
      unresolved: [
        ...new Set([
          ...BUILTIN_WRITE_DENYLIST.map((p) => resolve(p)),
          ...derivedAfkHomeWriteEntries(),
        ]),
        ...extras,
      ],
    };
  }

  // Do not memoize safeRealpath results. A configured or built-in entry can
  // contain a symlink whose target changes without any environment change.
  // Resolving after the cache hit keeps the security boundary synchronized
  // with the current filesystem topology.
  return [...new Set(cached.unresolved.map((p) => safeRealpath(p)))];
}

/**
 * Test-only: clear the memoized denylist so suites that mutate
 * `AFK_WRITE_DENYLIST` / `AFK_HOME` / `AFK_STATE_DIR` don't see a stale list.
 * Symlink repoints do not require a reset because real paths are never cached.
 * Mirrors
 * `_resetReadDenylistCacheForTests` in `read-denylist.ts`.
 */
export function _resetWriteDenylistCacheForTests(): void {
  cached = undefined;
}

/**
 * Resolve the real absolute path of `p`, dereferencing symlinks.
 *
 * For non-existent paths (e.g. a file about to be created), walk up the
 * parent chain until we find an existing ancestor, call `realpathSync` on it,
 * then rejoin the remaining tail segments. This means a symlink
 * `~/link → ~/.ssh` is correctly resolved even when the target file doesn't
 * yet exist.
 *
 * Never throws — falls back to `path.resolve` if the walk exhausts without
 * finding any real ancestor (e.g. an entirely synthetic path in tests).
 */
export function safeRealpath(p: string): string {
  const abs = resolve(p);

  // Fast path: the path already exists — resolve directly.
  try {
    return realpathSync(abs);
  } catch {
    // Path doesn't exist yet (or broken symlink chain). Walk up.
  }

  const parts: string[] = [];
  let current = abs;

  // Walk up until we find a real, existing ancestor.
  for (let i = 0; i < 64; i++) {
    const parent = dirname(current);
    if (parent === current) break; // reached filesystem root
    parts.unshift(current.slice(parent.length + 1)); // tail segment
    current = parent;
    try {
      const real = realpathSync(current);
      // Rejoin the tail segments beneath the resolved ancestor.
      return join(real, ...parts);
    } catch {
      // keep walking up
    }
  }

  // Could not resolve any ancestor — return the normalised absolute path.
  return abs;
}

/**
 * Throw if the resolved (symlink-dereferenced) file path falls inside a
 * denylisted prefix.
 *
 * @param filePath - The raw path as supplied by the model (may contain
 *   `~`, `..`, or symlink components).
 * @param handlerName - Tool name for the error message (`write_file` /
 *   `edit_file`).
 */
export function assertNotDenylisted(filePath: string, handlerName = 'write_file'): void {
  const real = safeRealpath(resolve(filePath));
  for (const blocked of getWriteDenylist()) {
    if (pathIsWithin(real, blocked)) {
      throw new Error(
        `${handlerName}: refusing to write to protected path: ${real}` +
          ` (matches denylist entry: ${blocked})`,
      );
    }
  }
}
