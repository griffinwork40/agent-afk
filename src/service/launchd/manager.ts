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
} from '../types.js';
import { guiDomain, LAUNCHCTL_TIMEOUT_MS, labelFor, plistPath, serviceLogPath } from './paths.js';
import { installService, readPlistFile, uninstallService } from './install.js';
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

  restart(name: ServiceName): ServiceRestartOutcome {
    if (!this.isInstalled(name)) {
      return { kind: 'not-installed', configPath: plistPath(name) };
    }
    // M-5: process.getuid is undefined on non-POSIX; on darwin it always
    // exists, but assert explicitly so a misuse surfaces here rather than
    // as a confusing launchctl "no such domain" error.
    if (typeof process.getuid !== 'function') {
      return { kind: 'failed', reason: 'process.getuid is unavailable — restart requires a POSIX system.' };
    }
    try {
      execFileSync('launchctl', ['kickstart', '-k', `${guiDomain()}/${labelFor(name)}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: LAUNCHCTL_TIMEOUT_MS,
      });
      return { kind: 'restarted', label: labelFor(name) };
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
