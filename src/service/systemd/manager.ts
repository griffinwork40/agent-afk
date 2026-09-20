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
  ServiceUpgradeOutcome,
} from '../types.js';
import { SYSTEMCTL_TIMEOUT_MS, serviceLogPath, systemdLabel, unitFileName, unitPath } from './paths.js';
import { installSystemdService, readUnitFile, uninstallSystemdService } from './install.js';
import { systemdStatus } from './status.js';
import { errorMessage } from '../../utils/errors.js';

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

  upgrade(_name: ServiceName, _opts?: ServiceInstallOptions): ServiceUpgradeOutcome {
    // Invariant: systemd unit upgrade is not yet implemented. The unit
    // content is re-rendered by `afk service install --force` (uninstall +
    // reinstall). A proper in-place upgrade like the launchd backend would
    // need to diff the .service unit, its companion .path unit, and the
    // oneshot restart helper. For now, advise reinstall.
    return { kind: 'failed', reason: 'In-place upgrade not yet supported for systemd. Run `afk service uninstall <name>` then `afk service install <name>`.' };
  },

  restart(name: ServiceName, _opts?: ServiceInstallOptions): ServiceRestartOutcome {
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
      const reason = stderr ? stderr.toString().trim() || errorMessage(e) : errorMessage(e);
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
