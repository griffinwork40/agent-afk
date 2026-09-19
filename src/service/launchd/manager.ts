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
import { serviceStatus } from './status.js';

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

  restart(name: ServiceName, opts?: ServiceInstallOptions): ServiceRestartOutcome {
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

    const upgradeStart = Date.now();
    const upgradeResult = upgradeService(name, opts ?? {});
    const upgradeElapsedMs = Date.now() - upgradeStart;
    // Invariant: debug line is intentionally low-cost — always emitted so a
    // failed upgrade is visible in logs even when the restart itself succeeds.
    // Uses process.stderr to avoid cluttering CLI stdout; callers that want
    // quiet output (tests, CI) set stdio:'ignore' on the outer execFileSync.
    if (process.env['AFK_DEBUG']) {
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
        execFileSync('launchctl', ['bootout', `${domain}/${label}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: LAUNCHCTL_TIMEOUT_MS,
        });
      } catch {
        // bootout may fail if the job was not loaded — non-fatal, proceed
        // to bootstrap so the updated plist is picked up regardless.
      }
      try {
        execFileSync('launchctl', ['bootstrap', domain, path], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: LAUNCHCTL_TIMEOUT_MS,
        });
        return { kind: 'restarted', label };
      } catch (e) {
        return { kind: 'failed', reason: (e as Error).message };
      }
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
      execFileSync('launchctl', ['kickstart', '-k', `${guiDomain()}/${labelFor(name)}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: LAUNCHCTL_TIMEOUT_MS,
      });
      return {
        kind: 'restarted',
        label: labelFor(name),
        ...(upgradeNotes.length > 0 ? { notes: upgradeNotes } : {}),
      };
    } catch (e) {
      return { kind: 'failed', reason: (e as Error).message };
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
