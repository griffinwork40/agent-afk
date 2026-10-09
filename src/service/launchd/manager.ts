/**
 * launchd backend for the platform-neutral {@link ServiceManager} contract
 * (darwin).
 *
 * Thin adapter: delegates to the existing launchd free-functions in this
 * folder (unchanged) and maps their launchd-flavoured result types
 * (`plistPath`, `watchPathsActive`) onto the neutral shapes in
 * `../types.ts`. Keeping the delegation here means `launchd/{install,status,
 * plist,paths}.ts` and their 776-line test-suite need no changes.
 *
 * The `restart` implementation is lifted verbatim from the old
 * `cli/commands/service.ts` inline `launchctl kickstart -k` call, so the
 * CLI can now treat restart as just another backend method.
 *
 * @module service/launchd/manager
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import type {
  ServiceInstallOptions,
  ServiceInstallOutcome,
  ServiceManager,
  ServiceName,
  ServiceRestartOutcome,
  ServiceStatus,
  ServiceUninstallOutcome,
  ServiceUpgradeOutcome,
} from '../types.js';
import { guiDomain, LAUNCHCTL_TIMEOUT_MS, labelFor, plistPath, serviceLogPath } from './paths.js';
import { installService, readPlistFile, uninstallService, upgradeService } from './install.js';
import { parseLaunchctlListRow, serviceStatus } from './status.js';
import { env } from '../../config/env.js';
import { errorMessage } from '../../utils/errors.js';

/**
 * Delay in milliseconds between the first failed bootstrap and the retry
 * attempt. A short pause lets the launchd gui/<uid> domain finish its
 * internal bookkeeping after a rapid bootout→bootstrap cycle.
 *
 * Kept as a named constant so unit tests can override it via
 * {@link LaunchdManagerDeps.bootstrapRetryDelayMs}.
 */
export const BOOTSTRAP_RETRY_DELAY_MS = 2_000;

/**
 * Injectable dependencies for {@link bootstrapWithRetry}. Separates the
 * side-effecting OS calls from the control-flow logic so unit tests can
 * exercise the retry and fallback paths without invoking real launchctl or
 * sleeping.
 *
 * Production code uses the defaults (real `execFileSync`,
 * `Atomics.wait`-based sync sleep). Tests replace only the calls they care
 * about.
 */
export interface LaunchdManagerDeps {
  /**
   * Replacement for `child_process.execFileSync`. Receives the same
   * arguments: `(file, args, options)`. Return value is ignored by the
   * caller; throw to simulate a launchctl failure.
   */
  execFileSync: typeof execFileSync;
  /**
   * Synchronous sleep used between bootstrap attempts. Receives the delay
   * in milliseconds. Production implementation uses `Atomics.wait` (blocks
   * the event loop for exactly `ms` ms without spawning a timer). Test
   * implementations are no-ops so tests run instantly.
   */
  sleepSync: (ms: number) => void;
  /**
   * Delay (ms) to wait before retrying bootstrap after a transient failure.
   * Defaults to {@link BOOTSTRAP_RETRY_DELAY_MS}. Set to 0 in tests.
   */
  bootstrapRetryDelayMs: number;
}

/**
 * Synchronous sleep using `Atomics.wait` on a shared buffer.
 * Blocks the calling thread for exactly `ms` milliseconds without
 * allocating a timer or yielding to the event loop. Safe on the main
 * thread when the blocking duration is bounded (a few seconds at most).
 */
function sleepSyncDefault(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Production-default injectable deps — real OS calls, real sync sleep. */
export function defaultLaunchdManagerDeps(): LaunchdManagerDeps {
  return {
    execFileSync,
    sleepSync: sleepSyncDefault,
    bootstrapRetryDelayMs: BOOTSTRAP_RETRY_DELAY_MS,
  };
}

/**
 * Check whether the named service is currently loaded in the launchd domain
 * by running `launchctl list` and looking for its label. Returns `true` if
 * the label appears in the list (the timed-out bootstrap may have actually
 * succeeded), `false` if it does not appear or if `launchctl list` itself
 * fails.
 *
 * Extracted as a named function so it can be tested independently.
 */
export function isServiceLoadedViaList(
  label: string,
  deps: Pick<LaunchdManagerDeps, 'execFileSync'>,
): boolean {
  try {
    const table = deps.execFileSync('launchctl', ['list'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: LAUNCHCTL_TIMEOUT_MS,
    }) as string;
    return parseLaunchctlListRow(table, label) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Returns true when `err` is an ETIMEDOUT error — the class of launchctl
 * timeout where the spawn timed out before the XPC handshake completed.
 * In this case launchd may have actually completed the bootstrap on its
 * side even though the client side received an error, so the service
 * might already be loaded.
 *
 * A genuine "already bootstrapped" (double-bootstrap) error is NOT
 * ETIMEDOUT — it carries the domain-specific "already bootstrapped"
 * message. An ETIMEDOUT means launchd silently completed the load but
 * the client timed out waiting for the reply.
 *
 * @internal — Not exported; used only by {@link bootstrapWithRetry}.
 */
function isEtimedout(err: unknown): boolean {
  return err instanceof Error && err.message.includes('ETIMEDOUT');
}

/**
 * Attempt to bootstrap the service, with one retry after a short delay if
 * the first attempt fails.
 *
 * The `isServiceLoadedViaList` check is only trusted when the first error
 * is ETIMEDOUT — the case where launchd may have completed the load on its
 * side despite the client-side timeout. For any other error class, calling
 * `isServiceLoadedViaList` could return `true` because a stale OLD job is
 * still loaded (when a prior `bootout` silently failed and swallowed its
 * error), not because the new bootstrap succeeded. In that case trusting
 * the list would cause `restart()` to report success while the NEW plist
 * was never actually loaded. Instead, fall straight through to the retry.
 *
 * For the retry attempt, the same ETIMEDOUT guard applies: if the retry
 * itself timed out AND the service appears in the list, the XPC handshake
 * likely completed on launchd's side — return `already-loaded` rather
 * than `failed`.
 *
 * Returns `{ kind: 'ok' }` when bootstrap succeeds (first try or retry),
 * `{ kind: 'already-loaded' }` when an ETIMEDOUT bootstrap actually
 * loaded the service (detectable via `launchctl list`), or
 * `{ kind: 'failed'; reason: string }` when bootstrap fails after the retry.
 *
 * @param name   - Service name, used only in the recovery-hint message.
 * @param domain - launchd gui/<uid> domain string.
 * @param path   - Absolute path to the plist file.
 * @param deps   - Injectable deps (execFileSync, sleepSync, bootstrapRetryDelayMs).
 */
export function bootstrapWithRetry(
  name: ServiceName,
  domain: string,
  path: string,
  deps: LaunchdManagerDeps,
): { kind: 'ok' } | { kind: 'already-loaded' } | { kind: 'failed'; reason: string } {
  const label = labelFor(name);

  // ── First bootstrap attempt ────────────────────────────────────────────
  try {
    deps.execFileSync('launchctl', ['bootstrap', domain, path], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: LAUNCHCTL_TIMEOUT_MS,
    });
    return { kind: 'ok' };
  } catch (firstErr) {
    // Bug 1 fix: only trust `isServiceLoadedViaList` for ETIMEDOUT errors.
    //
    // A real "already bootstrapped" double-bootstrap error is NOT ETIMEDOUT
    // — it carries the domain-specific error message. ETIMEDOUT means the
    // XPC handshake timed out on the client side but launchd may have
    // completed the load. Any other error class (permission error, bad plist,
    // etc.) cannot safely assume the service is newly loaded — it might be a
    // stale OLD job from a prior bootout that silently failed. In that case,
    // trusting the list would incorrectly return 'already-loaded' when the
    // old job is still loaded and the new plist was never applied.
    if (isEtimedout(firstErr) && isServiceLoadedViaList(label, deps)) {
      return { kind: 'already-loaded' };
    }

    // Service is NOT loaded (or error was not ETIMEDOUT) — the bootstrap
    // genuinely failed. Wait briefly to let the gui/<uid> domain settle
    // after the bootout→bootstrap cycle, then retry once.
    deps.sleepSync(deps.bootstrapRetryDelayMs);

    try {
      deps.execFileSync('launchctl', ['bootstrap', domain, path], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: LAUNCHCTL_TIMEOUT_MS,
      });
      return { kind: 'ok' };
    } catch (retryErr) {
      // Bug 2 fix: mirror the ETIMEDOUT guard for the retry attempt.
      //
      // If the retry itself timed out AND the service appears in the list,
      // the XPC handshake likely completed on launchd's side before the
      // client-side timeout fired — treat as success to avoid a spurious
      // 'failed' result when the service is actually running.
      if (isEtimedout(retryErr) && isServiceLoadedViaList(label, deps)) {
        return { kind: 'already-loaded' };
      }

      // Both attempts failed with no evidence of the service loading.
      // Return a clear message naming the stopped state and the exact
      // recovery command.
      const firstMsg = errorMessage(firstErr);
      const retryMsg = errorMessage(retryErr);
      const reason =
        `Service was stopped but could not be restarted ` +
        `(bootstrap failed: ${retryMsg}; first attempt: ${firstMsg}). ` +
        `Run: afk service uninstall ${name} && afk service install ${name}`;
      return { kind: 'failed', reason };
    }
  }
}

export const launchdManager: ServiceManager = {
  backend: 'launchd',
  configKind: 'LaunchAgent plist',

  install(name: ServiceName, opts: ServiceInstallOptions = {}): ServiceInstallOutcome {
    const result = installService(name, {
      noWatch: opts.noWatch ?? false,
      skipBootstrap: opts.dryRun ?? false,
      ...(opts.environment ? { environment: opts.environment } : {}),
    });
    if (result.kind === 'already-installed') {
      return { kind: 'already-installed', configPath: result.plistPath, label: result.label };
    }
    if (result.kind === 'failed') {
      return { kind: 'failed', reason: result.reason };
    }
    const notes: string[] = [];
    if (opts.dryRun) {
      // M-10: interpolate the real uid so the copy-paste command works on
      // this machine ($(id -u) would only expand inside a shell).
      const uid = process.getuid?.() ?? 501;
      notes.push('(dry-run) launchctl bootstrap was skipped; service is NOT yet running.');
      notes.push(`Load manually: launchctl bootstrap gui/${uid} ${result.plistPath}`);
    }
    return {
      kind: 'installed',
      configPath: result.plistPath,
      label: result.label,
      autoRestartOnRebuild: result.watchPathsActive,
      ...(notes.length > 0 ? { notes } : {}),
    };
  },

  uninstall(name: ServiceName): ServiceUninstallOutcome {
    const result = uninstallService(name);
    if (result.kind === 'failed') return { kind: 'failed', reason: result.reason };
    return { kind: result.kind, configPath: result.plistPath };
  },

  status(name: ServiceName): ServiceStatus {
    const s = serviceStatus(name);
    return {
      name: s.name,
      label: s.label,
      installed: s.installed,
      configPath: s.plistPath,
      logFile: s.logFile,
      ...(s.pid !== undefined ? { pid: s.pid } : {}),
      ...(s.lastExitStatus !== undefined ? { lastExitStatus: s.lastExitStatus } : {}),
    };
  },

  upgrade(name: ServiceName, opts: ServiceInstallOptions = {}): ServiceUpgradeOutcome {
    const result = upgradeService(name, {
      noWatch: opts.noWatch ?? false,
      ...(opts.environment ? { environment: opts.environment } : {}),
    });
    if (result.kind === 'upgraded') {
      return { kind: 'upgraded', configPath: result.plistPath, label: result.label };
    }
    if (result.kind === 'already-current') {
      return { kind: 'already-current', configPath: result.plistPath, label: result.label };
    }
    if (result.kind === 'not-installed') {
      return { kind: 'not-installed', configPath: result.plistPath };
    }
    return { kind: 'failed', reason: result.reason };
  },

  restart(name: ServiceName, opts?: ServiceInstallOptions, _deps?: LaunchdManagerDeps): ServiceRestartOutcome {
    if (!this.isInstalled(name)) {
      return { kind: 'not-installed', configPath: plistPath(name) };
    }

    // Invariant: before restarting the process, ensure the on-disk plist
    // matches what the current code would render. Without this, a version
    // upgrade that adds new plist keys (e.g. ThrottleInterval) only takes
    // effect for fresh installs, and existing users remain on the old
    // config indefinitely.
    //
    // When the plist was actually rewritten ('upgraded'), a simple
    // `kickstart -k` is NOT sufficient: it restarts the process but launchd
    // keeps the OLD in-memory job definition. New keys (ThrottleInterval,
    // EnvironmentVariables, etc.) only take effect after a full
    // bootout → bootstrap cycle that forces launchd to re-read the plist
    // from disk. When the plist is already current, kickstart -k is cheaper
    // (no definition reload) and is still correct.
    //
    // upgradeService() returns a result object and never throws — the
    // try/catch wrapper was dead code. We capture the result for logging
    // and to choose the right restart strategy.

    // M-5: process.getuid is undefined on non-POSIX; on darwin it always
    // exists, but assert explicitly so a misuse surfaces here rather than
    // as a confusing launchctl "no such domain" error.
    if (typeof process.getuid !== 'function') {
      return { kind: 'failed', reason: 'process.getuid is unavailable — restart requires a POSIX system.' };
    }

    const deps = _deps ?? defaultLaunchdManagerDeps();

    const upgradeStart = Date.now();
    const upgradeResult = upgradeService(name, opts ?? {});
    const upgradeElapsedMs = Date.now() - upgradeStart;
    // Invariant: debug line is intentionally low-cost — always emitted so a
    // failed upgrade is visible in logs even when the restart itself succeeds.
    // Uses process.stderr to avoid cluttering CLI stdout; callers that want
    // quiet output (tests, CI) set stdio:'ignore' on the outer execFileSync.
    if (env.AFK_DEBUG) {
      process.stderr.write(
        `[afk:service] restart upgradeService kind=${upgradeResult.kind} elapsed=${upgradeElapsedMs}ms\n`,
      );
    }
    if (upgradeResult.kind === 'upgraded') {
      // Plist was rewritten — force launchd to re-read from disk via a
      // full bootout → bootstrap cycle (mirrors installService / uninstallService).
      const label = labelFor(name);
      const domain = guiDomain();
      const path = plistPath(name);
      try {
        deps.execFileSync('launchctl', ['bootout', `${domain}/${label}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: LAUNCHCTL_TIMEOUT_MS,
        });
      } catch {
        // bootout may fail if the job was not loaded — non-fatal, proceed
        // to bootstrap so the updated plist is picked up regardless.
      }

      // Bootstrap with retry: if the first attempt fails (e.g. ETIMEDOUT
      // during a rapid bootout→bootstrap cycle), check whether the service
      // actually loaded (timed-out-but-actually-loaded), then retry once
      // after a short delay before declaring failure.
      const bootstrapResult = bootstrapWithRetry(name, domain, path, deps);
      if (bootstrapResult.kind === 'ok' || bootstrapResult.kind === 'already-loaded') {
        return { kind: 'restarted', label };
      }
      return { kind: 'failed', reason: bootstrapResult.reason };
    }

    // Plist upgrade failed — collect the reason as a note so the caller can
    // surface it. We still proceed with kickstart -k: the service must be
    // restarted regardless, and a failed upgrade is non-fatal for the restart
    // itself (the existing on-disk plist is still valid).
    const upgradeNotes: string[] = [];
    if (upgradeResult.kind === 'failed') {
      upgradeNotes.push(`Warning: plist upgrade failed (${upgradeResult.reason}). The service was restarted with the existing config.`);
    }

    // Plist unchanged (already-current), not installed, or upgrade failed —
    // fall back to kickstart -k for a lighter-weight process restart.
    try {
      deps.execFileSync('launchctl', ['kickstart', '-k', `${guiDomain()}/${labelFor(name)}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: LAUNCHCTL_TIMEOUT_MS,
      });
      return {
        kind: 'restarted',
        label: labelFor(name),
        ...(upgradeNotes.length > 0 ? { notes: upgradeNotes } : {}),
      };
    } catch (e) {
      return { kind: 'failed', reason: errorMessage(e) };
    }
  },

  isInstalled(name: ServiceName): boolean {
    return existsSync(plistPath(name));
  },

  configPath(name: ServiceName): string {
    return plistPath(name);
  },

  logPath(name: ServiceName): string {
    return serviceLogPath(name);
  },

  label(name: ServiceName): string {
    return labelFor(name);
  },

  readConfigFile(name: ServiceName): string | undefined {
    return readPlistFile(name);
  },
};
