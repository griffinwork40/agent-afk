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
 * Called fresh on every {@link getWriteDenylist} call (this module is
 * uncached, unlike the read denylist), so no separate cache-key concern
 * applies here — a runtime `AFK_HOME` / `AFK_STATE_DIR` change is picked up on
 * the very next call.
 */
function derivedAfkHomeWriteEntries(): string[] {
  const entries: string[] = [];
  try {
    const home = getAfkHome();
    entries.push(safeRealpath(resolve(join(home, 'config'))));
    entries.push(safeRealpath(resolve(join(home, 'state'))));
  } catch (err) {
    warnAfkHomeRejectedOnce(err);
  }
  try {
    entries.push(safeRealpath(resolve(getAfkStateDir())));
  } catch (err) {
    warnAfkHomeRejectedOnce(err);
  }
  return entries;
}

/**
 * Return the effective denylist (builtin + any user-supplied extras).
 * Entries are returned as real (symlink-resolved) absolute paths.
 *
 * @note AFK_WRITE_DENYLIST is split on `:` — paths that themselves contain
 * a colon (unusual on POSIX, impossible on macOS HFS+) will be mis-split.
 * Use a different separator character if your paths require colons.
 */
export function getWriteDenylist(): readonly string[] {
  const extra = env.AFK_WRITE_DENYLIST;
  const extras: string[] = extra
    ? extra.split(':').map((p) => safeRealpath(resolve(p))).filter(Boolean)
    : [];
  const builtins = [
    ...new Set([
      ...BUILTIN_WRITE_DENYLIST.map((p) => safeRealpath(resolve(p))),
      ...derivedAfkHomeWriteEntries(),
    ]),
  ];
  return [...builtins, ...extras];
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
