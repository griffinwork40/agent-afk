/**
 * systemd backend for the platform-neutral {@link ServiceManager} contract
 * (linux). Thin wiring over `./install.ts`, `./status.ts`, and a
 * `systemctl --user restart` for restart.
 *
 * @module service/systemd/manager
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
import { SYSTEMCTL_TIMEOUT_MS, serviceLogPath, systemdLabel, unitFileName, unitPath } from './paths.js';
import { installSystemdService, readUnitFile, uninstallSystemdService } from './install.js';
import { systemdStatus } from './status.js';

export const systemdManager: ServiceManager = {
  backend: 'systemd',
  configKind: 'systemd user unit',

  install(name: ServiceName, opts: ServiceInstallOptions = {}): ServiceInstallOutcome {
    return installSystemdService(name, opts);
  },

  uninstall(name: ServiceName): ServiceUninstallOutcome {
    return uninstallSystemdService(name);
  },

  status(name: ServiceName): ServiceStatus {
    return systemdStatus(name);
  },

  restart(name: ServiceName): ServiceRestartOutcome {
    if (!existsSync(unitPath(name))) {
      return { kind: 'not-installed', configPath: unitPath(name) };
    }
    try {
      execFileSync('systemctl', ['--user', 'restart', unitFileName(name)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SYSTEMCTL_TIMEOUT_MS,
      });
      return { kind: 'restarted', label: systemdLabel(name) };
    } catch (e) {
      const stderr = (e as { stderr?: Buffer | string }).stderr;
      const reason = stderr ? stderr.toString().trim() || (e as Error).message : (e as Error).message;
      return { kind: 'failed', reason };
    }
  },

  isInstalled(name: ServiceName): boolean {
    return existsSync(unitPath(name));
  },

  configPath(name: ServiceName): string {
    return unitPath(name);
  },

  logPath(name: ServiceName): string {
    return serviceLogPath(name);
  },

  label(name: ServiceName): string {
    return systemdLabel(name);
  },

  readConfigFile(name: ServiceName): string | undefined {
    return readUnitFile(name);
  },
};
