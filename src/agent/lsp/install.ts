/**
 * LSP server install orchestrator (#4272, stage 2 — D-core lane).
 *
 * Implements `EnsureInstalledFn` from `server-spec.ts`. Policy:
 *
 *   1. Binary already present → {kind:'installed', freshInstall:false}.
 *   2. No install recipe → {kind:'no-recipe'}.
 *   3. Stored grant exists → install without prompting (daemon-safe).
 *   4. No grant + !ctx.interactive → {kind:'refused-unattended'}.
 *   5. No grant + interactive → ask via ctx.askConsent; decline → {kind:'declined'}.
 *   6. Approved → persist grant BEFORE install, run npm, verify bin, ledger rows.
 *
 * Concurrency: concurrent ensure calls for the same language AND the same
 * `interactive` flag share one in-flight Promise (dedup map). Keying on
 * `interactive` too means an interactive caller never inherits an unattended
 * caller's `refused-unattended` (#4293 review C-5).
 *
 * Cross-process locking: a `.installing.<language>` sentinel file in the LSP
 * servers dir guards against two AFK processes running `npm install` into the
 * same language directory simultaneously (#4309 item 3). The sentinel carries
 * `{pid, expiresAt}` so a crashed writer's lock is not held forever — any
 * lock older than LOCK_EXPIRY_MS (5 min) is considered stale and overwritten.
 *
 * Never throws: ledger I/O errors, path-validation errors, and any other
 * unexpected failure map to `{kind:'failed'}` (review C-5).
 *
 * @module agent/lsp/install
 */

import { access, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { EffectStore } from '../effect-ledger/store.js';
import {
  getLspInstalledBinPath,
  getLspLanguageInstallDir,
  getLspServersDir,
} from '../../paths.lsp.js';
import type {
  ServerDefinition,
  InstallContext,
  EnsureInstalledResult,
  EnsureInstalledFn,
} from './server-spec.js';
import { createGrantStore, type GrantStore } from './install.grants.js';
import { runNpmInstall, sanitizeFailureReason, type NpmExecFn } from './install.npm.js';

// ---------------------------------------------------------------------------
// Cross-process advisory install lock (#4309 item 3)
// ---------------------------------------------------------------------------
// Sentinel file: <lspServersDir>/.installing.<language>
// Content: JSON { pid: number, expiresAt: number (epoch ms) }
// A lock is considered stale (dead writer) when expiresAt < Date.now().
// ---------------------------------------------------------------------------

/** How long a lock is considered valid before being treated as stale. */
const LOCK_EXPIRY_MS = 5 * 60 * 1_000; // 5 minutes
/** Poll interval while waiting for another process's lock. */
const LOCK_POLL_MS = 500;

interface LockRecord { pid: number; expiresAt: number }

/** Path of the sentinel file for `language`. Exported for tests. */
export function installLockPath(language: string, serversDir?: string): string {
  if (!/^[a-z][a-z0-9_-]*$/i.test(language)) {
    throw new Error(`Invalid language identifier: ${language}`);
  }
  return join(serversDir ?? getLspServersDir(), `.installing.${language}`);
}

/**
 * Acquire an advisory install lock for `language`. Resolves when the lock is
 * held by this process. Returns a release function — always call it in a
 * `finally` block. If `signal` is aborted while waiting, throws an
 * `AbortError`.
 *
 * Injectable `opts` for tests: `serversDir`, `pid`, `nowMs`, `pollMs`.
 */
export async function acquireInstallLock(
  language: string,
  signal?: AbortSignal,
  opts?: { serversDir?: string; pid?: number; nowMs?: () => number; pollMs?: number },
): Promise<() => Promise<void>> {
  const lockFile = installLockPath(language, opts?.serversDir);
  const ownPid = opts?.pid ?? process.pid;
  const now = opts?.nowMs ?? (() => Date.now());
  const pollMs = opts?.pollMs ?? LOCK_POLL_MS;

  // Ensure the directory exists before writing the sentinel.
  await mkdir(join(lockFile, '..'), { recursive: true });

  while (true) {
    if (signal?.aborted) throw Object.assign(new Error('Install lock wait aborted'), { name: 'AbortError' });

    // Atomically create the lock file (O_EXCL: fail if it already exists).
    const record: LockRecord = { pid: ownPid, expiresAt: now() + LOCK_EXPIRY_MS };
    try {
      const fh = await open(lockFile, 'wx');
      await fh.writeFile(JSON.stringify(record), 'utf8');
      await fh.close();
      // We hold the lock.
      return async (): Promise<void> => {
        try { await unlink(lockFile); } catch { /* already removed */ }
      };
    } catch (err: unknown) {
      // EEXIST → another process has the file; check staleness below.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        // Unexpected error (EACCES, EMFILE, EROFS, …) — propagate so
        // ensureInstalledSafe maps it to {kind:'failed'} instead of
        // proceeding without the lock.
        throw err;
      }
    }

    // Read existing lock to determine staleness.
    let existing: LockRecord | null = null;
    try {
      const fh = await open(lockFile, 'r');
      const raw = await fh.readFile('utf8');
      await fh.close();
      existing = JSON.parse(raw) as LockRecord;
    } catch {
      // File vanished between our failed open('wx') and now — loop and retry.
      continue;
    }

    if (existing.expiresAt < now()) {
      // Stale lock from a crashed writer — remove it and retry the O_EXCL open.
      try { await unlink(lockFile); } catch { /* already removed by a peer */ }
      continue;
    }

    // Another live process holds the lock — wait and retry.
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}

// ---------------------------------------------------------------------------
// In-process dedup map
// ---------------------------------------------------------------------------

/** Active install Promises keyed by `inFlightKey`. Prevents duplicate installs
 *  when multiple callers race within the same process. */
const inFlight = new Map<string, Promise<EnsureInstalledResult>>();

// ---------------------------------------------------------------------------
// Ledger operation type
// ---------------------------------------------------------------------------

const LSP_INSTALL_OP = 'lsp_install';

// ---------------------------------------------------------------------------
// Injectable deps interface
// ---------------------------------------------------------------------------

export interface InstallDeps {
  /** Override grant store (default: file-backed). */
  grantStore?: GrantStore;
  /** Override npm executor (default: real execFile). */
  execFn?: NpmExecFn;
  /** Override effect ledger store path (default: global ledger). */
  ledgerPath?: string;
  /** Override platform for npm bin resolution. */
  platform?: string;
  /** Override the win32 npm-cli.js locator (tests). */
  locateCli?: () => string | undefined;
  /** Override in-flight map (tests can supply a fresh map per test). */
  inFlightMap?: Map<string, Promise<EnsureInstalledResult>>;
  /**
   * Override the cross-process lock acquisition function (tests).
   * Receives the language name and optional AbortSignal; resolves to a
   * release function. Default: `acquireInstallLock`.
   */
  lockFn?: (language: string, signal?: AbortSignal) => Promise<() => Promise<void>>;
}

// ---------------------------------------------------------------------------
// Core (non-deduped) implementation
// ---------------------------------------------------------------------------

async function ensureInstalledCore(
  definition: ServerDefinition,
  ctx: InstallContext,
  deps: InstallDeps,
): Promise<EnsureInstalledResult> {
  const { language, binName, install } = definition;

  // 1. Binary already installed?
  const binPath = getLspInstalledBinPath(language, binName);
  try {
    await access(binPath);
    return { kind: 'installed', command: binPath, freshInstall: false };
  } catch {
    // Not installed — continue.
  }

  // 2. No recipe?
  if (install === undefined) {
    return { kind: 'no-recipe' };
  }

  const grantStore = deps.grantStore ?? createGrantStore();
  const ledger = new EffectStore(deps.ledgerPath);

  // 3. Check stored grant.
  const hasGrant = await grantStore.hasGrant(language);

  if (!hasGrant) {
    // 4. No grant + unattended → refuse.
    if (!ctx.interactive) {
      return { kind: 'refused-unattended' };
    }

    // 5. No grant + interactive → ask.
    if (ctx.askConsent === undefined) {
      return { kind: 'declined' };
    }

    const installDir = getLspLanguageInstallDir(language);
    const prompt =
      `AFK needs to install the ${language} language server.\n` +
      `  Packages: ${install.packages.join(', ')}\n` +
      `  Directory: ${installDir}\n` +
      `Approve? (yes/no)`;

    const approved = await ctx.askConsent(prompt);
    if (!approved) {
      return { kind: 'declined' };
    }

    // 6a. Persist grant BEFORE installing.
    await grantStore.persistGrant(language, install.packages);
  }

  // 6b. Acquire cross-process advisory lock before touching the install dir
  // (#4309 item 3). Two AFK processes (e.g. daemon + interactive) can race
  // to install the same language server; the lock serialises them. npm install
  // is idempotent, so a concurrent winner just means the loser's bin-check
  // (step 6d) passes immediately — the lock keeps npm output coherent and
  // avoids partial-state races during the install.
  // ctx.signal is forwarded so an aborted caller does not wait indefinitely.
  const acquireLock = deps.lockFn ?? acquireInstallLock;
  const releaseLock = await acquireLock(language, ctx.signal);

  // The finally block below covers everything from lock acquisition onward,
  // including ledger.writePending and the binary re-check.
  try {
    // Re-check the binary now that we hold the lock: another process may have
    // already finished the install while we were waiting.
    try {
      await access(binPath);
      return { kind: 'installed', command: binPath, freshInstall: false };
    } catch {
      // Still not installed — proceed.
    }

    // 6c. Write-ahead to effect ledger (pending).
    const idempotencyKey = `${LSP_INSTALL_OP}:${language}:${[...install.packages].sort().join(',')}`;
    const pendingRecord = ledger.writePending({
      idempotencyKey,
      operationType: LSP_INSTALL_OP,
      args: { language, packages: install.packages },
    });

    // 6d. Run npm install.
    const result = await runNpmInstall(
      language,
      install.packages,
      ctx.signal,
      deps.execFn,
      deps.platform ?? process.platform,
      deps.locateCli,
    );

    if (!result.ok) {
      await ledger.updateStatus({ id: pendingRecord.id, status: 'failed', result: { reason: result.reason } });
      return { kind: 'failed', reason: result.reason };
    }

    // 6e. Verify binary exists after install.
    try {
      await access(binPath);
    } catch {
      const reason = `npm install succeeded but binary not found at ${binPath}`;
      await ledger.updateStatus({ id: pendingRecord.id, status: 'failed', result: { reason } });
      return { kind: 'failed', reason };
    }

    // 6f. Resolve ledger to executed.
    await ledger.updateStatus({ id: pendingRecord.id, status: 'executed', result: { binPath } });

    return { kind: 'installed', command: binPath, freshInstall: true };
  } finally {
    await releaseLock();
  }
}

/** Run the core; any thrown error (ledger I/O, fs, paths) maps to failed. */
async function ensureInstalledSafe(
  definition: ServerDefinition,
  ctx: InstallContext,
  deps: InstallDeps,
): Promise<EnsureInstalledResult> {
  try {
    return await ensureInstalledCore(definition, ctx, deps);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'failed', reason: sanitizeFailureReason(`LSP install error: ${message}`) };
  }
}

/** In-flight dedupe key: language + whether a human is reachable. */
export function inFlightKey(language: string, interactive: boolean): string {
  return `${language}\u0000${interactive ? 'interactive' : 'unattended'}`;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create an `EnsureInstalledFn` with injectable dependencies.
 *
 * @example Default (production):
 *   const ensureServerInstalled = createEnsureInstalled();
 *
 * @example Test:
 *   const ensureServerInstalled = createEnsureInstalled({
 *     grantStore: mockGrantStore,
 *     execFn: fakeExecFn,
 *     inFlightMap: new Map(),
 *   });
 */
export function createEnsureInstalled(deps: InstallDeps = {}): EnsureInstalledFn {
  const map = deps.inFlightMap ?? inFlight;

  return function ensureServerInstalled(
    definition: ServerDefinition,
    ctx: InstallContext,
  ): Promise<EnsureInstalledResult> {
    const key = inFlightKey(definition.language, ctx.interactive);
    const existing = map.get(key);
    if (existing !== undefined) return existing;

    const promise = ensureInstalledSafe(definition, ctx, deps).finally(() => {
      map.delete(key);
    });
    map.set(key, promise);
    return promise;
  };
}

/**
 * Default `EnsureInstalledFn` instance using the global in-flight map and
 * real fs/npm/ledger. Import this for production use.
 */
export const ensureServerInstalled: EnsureInstalledFn = createEnsureInstalled();
