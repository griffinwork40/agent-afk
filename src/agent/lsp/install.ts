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
 * Concurrency: concurrent ensure calls for the same language share one
 * in-flight Promise (dedup map). Cross-process locking is NOT implemented
 * because no file-lock helper exists in the repo; see GAP comment below.
 *
 * @module agent/lsp/install
 */

import { access } from 'node:fs/promises';
import { EffectStore } from '../effect-ledger/store.js';
import {
  getLspInstalledBinPath,
  getLspLanguageInstallDir,
} from '../../paths.lsp.js';
import type {
  ServerDefinition,
  InstallContext,
  EnsureInstalledResult,
  EnsureInstalledFn,
} from './server-spec.js';
import { createGrantStore, type GrantStore } from './install.grants.js';
import { runNpmInstall, type NpmExecFn } from './install.npm.js';

// ---------------------------------------------------------------------------
// GAP: cross-process file lock
// ---------------------------------------------------------------------------
// No file-lock helper exists in this repo (grep: flock, lockfile, LockFile).
// Concurrent installs from two processes targeting the same language dir are
// not prevented. Risk is low — npm install is idempotent and the bin-check
// after install catches any partial state — but a proper advisory lock (e.g.
// a `.installing` sentinel file with PID + expiry) is the recommended follow-up.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// In-process dedup map
// ---------------------------------------------------------------------------

/** Active install Promises keyed by language. Prevents duplicate installs
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
  /** Override in-flight map (tests can supply a fresh map per test). */
  inFlightMap?: Map<string, Promise<EnsureInstalledResult>>;
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

  // 6b. Write-ahead to effect ledger (pending).
  const idempotencyKey = `${LSP_INSTALL_OP}:${language}:${[...install.packages].sort().join(',')}`;
  const pendingRecord = ledger.writePending({
    idempotencyKey,
    operationType: LSP_INSTALL_OP,
    args: { language, packages: install.packages },
  });

  // 6c. Run npm install.
  const result = await runNpmInstall(
    language,
    install.packages,
    ctx.signal,
    deps.execFn,
    deps.platform ?? process.platform,
  );

  if (!result.ok) {
    await ledger.updateStatus({ id: pendingRecord.id, status: 'failed', result: { reason: result.reason } });
    return { kind: 'failed', reason: result.reason };
  }

  // 6d. Verify binary exists after install.
  try {
    await access(binPath);
  } catch {
    const reason = `npm install succeeded but binary not found at ${binPath}`;
    await ledger.updateStatus({ id: pendingRecord.id, status: 'failed', result: { reason } });
    return { kind: 'failed', reason };
  }

  // 6e. Resolve ledger to executed.
  await ledger.updateStatus({ id: pendingRecord.id, status: 'executed', result: { binPath } });

  return { kind: 'installed', command: binPath, freshInstall: true };
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
    const { language } = definition;
    const existing = map.get(language);
    if (existing !== undefined) return existing;

    const promise = ensureInstalledCore(definition, ctx, deps).finally(() => {
      map.delete(language);
    });
    map.set(language, promise);
    return promise;
  };
}

/**
 * Default `EnsureInstalledFn` instance using the global in-flight map and
 * real fs/npm/ledger. Import this for production use.
 */
export const ensureServerInstalled: EnsureInstalledFn = createEnsureInstalled();
