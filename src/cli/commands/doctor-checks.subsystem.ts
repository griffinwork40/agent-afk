/**
 * Subsystem health checks for `afk doctor`.
 *
 * Complements doctor-checks.ts with five additional checks:
 *   1. Memory store   — SQLite DB openable, basic row count sanity
 *   2. Daemon state   — daemon process running (pid lock-file check)
 *   3. Node.js version — matches engines.node from package.json
 *   4. Hook config syntax — settings.json hooks parseable, valid event names
 *   5. Witness directory — writable, disk not full
 *
 * Same invariants as doctor-checks.ts: no process.exit(), no stdout/stderr.
 */

import { access, constants, readFile, writeFile, unlink } from 'fs/promises';
import nodePath from 'path';
import { getStateDatabasePath, getSettingsPath, getWitnessRoot } from '../../paths.js';
import { getDaemonLockPath } from '../../agent/daemon-instance.lock.js';
import { isErrnoCode } from '../../utils/errors.js';
import type { Check } from './doctor-checks.js';

// ---------------------------------------------------------------------------
// Valid hook event names (mirrors HookEventNameSchema in trace/events.ts)
// ---------------------------------------------------------------------------

const VALID_HOOK_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'SubagentStart',
  'SubagentStop',
]);

// ---------------------------------------------------------------------------
// 1. Memory store
// ---------------------------------------------------------------------------

/** Injectable deps for testability. */
export interface MemoryStoreDeps {
  dbPath?: string;
  /** Open a SQLite DB and return a row count (or throw). Injected in tests. */
  openAndCount?: (dbPath: string) => Promise<number>;
}

/**
 * Try to open the SQLite KV store and do a trivial SELECT COUNT(*).
 * Returns warn (not fail) when the DB doesn't exist yet — it's created lazily
 * on first write, so a fresh install is healthy.
 */
export async function checkMemoryStore(deps: MemoryStoreDeps = {}): Promise<Check> {
  const dbPath = deps.dbPath ?? getStateDatabasePath();

  const openAndCount =
    deps.openAndCount ??
    (async (p: string) => {
      // Dynamic import keeps better-sqlite3 out of the module graph when unused.
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(p, { readonly: true, fileMustExist: true });
      try {
        const row = db.prepare('SELECT COUNT(*) as n FROM sqlite_master').get() as
          | { n: number }
          | undefined;
        return row?.n ?? 0;
      } finally {
        db.close();
      }
    });

  try {
    const count = await openAndCount(dbPath);
    return {
      name: 'Memory Store (SQLite)',
      state: 'pass',
      detail: `${dbPath} (${count} schema rows)`,
    };
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) {
      // Not yet created — healthy for a fresh install.
      return {
        name: 'Memory Store (SQLite)',
        state: 'pass',
        detail: 'not yet created (will be initialised on first use)',
      };
    }
    return {
      name: 'Memory Store (SQLite)',
      state: 'warn',
      detail: dbPath,
      fix: `Unable to open memory store: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// 2. Daemon state
// ---------------------------------------------------------------------------

/** Injectable deps for testability. */
export interface DaemonStateDeps {
  lockPath?: string;
  /** Read the PID from the lock file (or throw ENOENT when absent). */
  readLockFile?: (path: string) => Promise<string>;
  /** Return true when the process with the given PID is alive. */
  isAlive?: (pid: number) => boolean;
}

export async function checkDaemonState(deps: DaemonStateDeps = {}): Promise<Check> {
  const lockPath = deps.lockPath ?? getDaemonLockPath();
  const readLockFile =
    deps.readLockFile ?? ((p: string) => readFile(p, 'utf-8'));
  const isAlive =
    deps.isAlive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

  try {
    const raw = await readLockFile(lockPath);
    const pid = parseInt(raw.trim(), 10);
    if (isNaN(pid)) {
      return {
        name: 'Daemon State',
        state: 'warn',
        detail: `lock file contains non-numeric content: ${JSON.stringify(raw.trim())}`,
        fix: `Remove stale lock file: ${lockPath}`,
      };
    }
    if (isAlive(pid)) {
      return { name: 'Daemon State', state: 'pass', detail: `running (pid ${pid})` };
    }
    return {
      name: 'Daemon State',
      state: 'warn',
      detail: `stale lock file (pid ${pid} is not running)`,
      fix: `Remove stale lock: ${lockPath}`,
    };
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) {
      return { name: 'Daemon State', state: 'pass', detail: 'not running' };
    }
    return {
      name: 'Daemon State',
      state: 'warn',
      detail: `could not read lock file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// 3. Node.js version
// ---------------------------------------------------------------------------

/**
 * Minimal engines.node range checker — handles the `||`-separated list of
 * `^X.Y.Z` / `>=X.Y.Z` / `X.Y.Z` ranges that package.json uses.
 * Covers the real-world patterns in this repo without a semver dependency.
 */
function satisfiesEnginesNode(version: string, range: string): boolean {
  const parts = version.split('.').map(Number);
  const [major = 0, minor = 0, patch = 0] = parts;

  return range.split(/\s*\|\|\s*/).some((clause) => {
    const trimmed = clause.trim();

    // >=X.Y.Z — at or above a floor
    const geMatch = trimmed.match(/^>=(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
    if (geMatch) {
      const [, rMaj = '0', rMin = '0', rPatch = '0'] = geMatch;
      const [rM, rm, rp] = [Number(rMaj), Number(rMin), Number(rPatch)];
      return (
        major > rM ||
        (major === rM && minor > rm) ||
        (major === rM && minor === rm && patch >= rp)
      );
    }

    // ^X.Y.Z — same major, at or above minor.patch
    const caretMatch = trimmed.match(/^\^(\d+)\.(\d+)\.(\d+)$/);
    if (caretMatch) {
      const [, rMaj, rMin, rPatch] = caretMatch;
      const [rM, rm, rp] = [Number(rMaj), Number(rMin), Number(rPatch)];
      return (
        major === rM &&
        (minor > rm || (minor === rm && patch >= rp))
      );
    }

    // Exact X.Y.Z
    const exactMatch = trimmed.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (exactMatch) {
      const [, rMaj, rMin, rPatch] = exactMatch;
      return major === Number(rMaj) && minor === Number(rMin) && patch === Number(rPatch);
    }

    return false;
  });
}

/** Injectable deps for testability. */
export interface NodeVersionDeps {
  /**
   * engines.node range from package.json (e.g. "^22.22.2 || ^24.15.0").
   * Pass `null` in tests to simulate the "not found in package.json" path
   * without triggering a real file read.  `undefined` (default) means
   * "read from disk".
   */
  enginesNode?: string | null;
  /** Current Node version string, e.g. "v22.15.0". Defaults to process.version. */
  currentVersion?: string;
  /**
   * Resolve a semver range check.
   * Pass `null` in tests to simulate semver being unavailable (skips the
   * dynamic import).  `undefined` (default) means "import semver at runtime".
   */
  satisfies?: ((version: string, range: string) => boolean) | null;
}

export async function checkNodeVersion(deps: NodeVersionDeps = {}): Promise<Check> {
  const currentVersion = deps.currentVersion ?? process.version;

  // Lazily read engines.node from package.json when not injected.
  // `null` means "caller explicitly says it's absent" (test sentinel).
  let enginesNode: string | null | undefined = deps.enginesNode;
  if (enginesNode === undefined) {
    try {
      // Walk up from __dirname to find package.json (works compiled or source).
      const pkgPath = nodePath.resolve(
        nodePath.dirname(new URL(import.meta.url).pathname),
        '../../../package.json',
      );
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as {
        engines?: { node?: string };
      };
      enginesNode = pkg.engines?.node;
    } catch {
      enginesNode = undefined;
    }
  }

  if (!enginesNode) {
    // null = caller confirmed absent; falsy string = read failed/empty
    return {
      name: 'Node.js version',
      state: 'warn',
      detail: `${currentVersion} (engines.node not found in package.json)`,
    };
  }
  // TypeScript narrowing: enginesNode is string from here on.

  // Use injected satisfies fn, or fall back to a built-in range check.
  // `null` = test sentinel meaning "range check unavailable".
  // `undefined` (default) = use the built-in implementation below.
  let satisfiesFn: ((v: string, r: string) => boolean) | null | undefined;
  if ('satisfies' in deps) {
    satisfiesFn = deps.satisfies;
  } else {
    satisfiesFn = satisfiesEnginesNode;
  }

  if (!satisfiesFn) {
    return {
      name: 'Node.js version',
      state: 'warn',
      detail: `${currentVersion} (version range check unavailable; expected ${enginesNode})`,
    };
  }

  // Strip leading 'v' for comparison.
  const bare = currentVersion.replace(/^v/, '');
  if (satisfiesFn(bare, enginesNode)) {
    return {
      name: 'Node.js version',
      state: 'pass',
      detail: `${currentVersion} satisfies ${enginesNode}`,
    };
  }
  return {
    name: 'Node.js version',
    state: 'fail',
    detail: `${currentVersion} does not satisfy ${enginesNode}`,
    fix: `Upgrade Node.js to a version matching: ${enginesNode}`,
  };
}

// ---------------------------------------------------------------------------
// 4. Hook config syntax
// ---------------------------------------------------------------------------

/** Injectable deps for testability. */
export interface HookConfigDeps {
  settingsPath?: string;
  readFile?: (path: string) => Promise<string>;
}

export async function checkHookConfig(deps: HookConfigDeps = {}): Promise<Check> {
  const settingsPath = deps.settingsPath ?? getSettingsPath();
  const _readFile = deps.readFile ?? ((p: string) => readFile(p, 'utf-8'));

  let raw: string;
  try {
    raw = await _readFile(settingsPath);
  } catch (err) {
    if (isErrnoCode(err, 'ENOENT')) {
      return { name: 'Hook Config', state: 'pass', detail: 'no settings.json (no hooks configured)' };
    }
    return {
      name: 'Hook Config',
      state: 'warn',
      detail: `could not read ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Must be parseable JSON.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      name: 'Hook Config',
      state: 'fail',
      detail: settingsPath,
      fix: `settings.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // If no hooks key, nothing to validate.
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('hooks' in parsed) ||
    parsed.hooks === null ||
    typeof parsed.hooks !== 'object'
  ) {
    return { name: 'Hook Config', state: 'pass', detail: 'no hooks defined' };
  }

  const hooks = parsed.hooks as Record<string, unknown>;
  const invalidEvents = Object.keys(hooks).filter((k) => !VALID_HOOK_EVENTS.has(k));

  if (invalidEvents.length > 0) {
    return {
      name: 'Hook Config',
      state: 'warn',
      detail: `unknown hook event(s): ${invalidEvents.join(', ')}`,
      fix: `Valid events: ${[...VALID_HOOK_EVENTS].join(', ')}`,
    };
  }

  const eventCount = Object.keys(hooks).length;
  return {
    name: 'Hook Config',
    state: 'pass',
    detail: `${settingsPath} (${eventCount} event${eventCount === 1 ? '' : 's'} configured)`,
  };
}

// ---------------------------------------------------------------------------
// 5. Witness directory writability
// ---------------------------------------------------------------------------

/** Injectable deps for testability. */
export interface WitnessDirDeps {
  witnessRoot?: string;
  /** Check access — injected in tests. */
  checkAccess?: (path: string, mode: number) => Promise<void>;
  /** Write a probe file — injected in tests. */
  writeProbe?: (path: string) => Promise<void>;
  /** Remove the probe file — injected in tests. */
  removeProbe?: (path: string) => Promise<void>;
}

export async function checkWitnessDir(deps: WitnessDirDeps = {}): Promise<Check> {
  const witnessRoot = deps.witnessRoot ?? getWitnessRoot();
  const _checkAccess = deps.checkAccess ?? ((p, m) => access(p, m));
  const probePath = nodePath.join(witnessRoot, '.doctor-probe');

  const _writeProbe =
    deps.writeProbe ??
    (async (p: string) => {
      // Ensure directory exists first (mirrors checkDirWritable behaviour).
      const { mkdir } = await import('fs/promises');
      await mkdir(witnessRoot, { recursive: true });
      await writeFile(p, '');
    });
  const _removeProbe =
    deps.removeProbe ??
    ((p: string) => unlink(p).catch(() => {}));

  // Check directory is accessible.
  try {
    await _checkAccess(witnessRoot, constants.W_OK);
  } catch (accessErr) {
    if (!isErrnoCode(accessErr, 'ENOENT')) {
      return {
        name: 'Witness Directory',
        state: 'fail',
        detail: witnessRoot,
        fix: `Witness directory is not writable. Check permissions on ${witnessRoot}`,
      };
    }
    // ENOENT — directory doesn't exist yet; attempt creation via probe write.
  }

  // Attempt an actual write to catch ENOSPC / read-only fs.
  try {
    await _writeProbe(probePath);
    await _removeProbe(probePath);
    return { name: 'Witness Directory', state: 'pass', detail: witnessRoot };
  } catch (err) {
    if (isErrnoCode(err, 'ENOSPC')) {
      return {
        name: 'Witness Directory',
        state: 'fail',
        detail: witnessRoot,
        fix: 'Disk is full. Free space or change AFK_STATE_DIR.',
      };
    }
    return {
      name: 'Witness Directory',
      state: 'fail',
      detail: witnessRoot,
      fix: `Cannot write to witness directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
