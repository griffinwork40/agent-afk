/**
 * Windows Task Scheduler backend for the platform-neutral
 * {@link ServiceManager} contract (win32). Thin wiring over
 * `./install.ts`, `./status.ts`, and `schtasks /End` + `/Run`
 * for restart.
 *
 * @module service/windows/manager
 */

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
import { serviceLogPath, taskName, taskXmlPath } from './paths.js';
import { installWindowsTask, readTaskFile, renderWindowsTask, uninstallWindowsTask, writeUtf16Le } from './install.js';
import { windowsStatus } from './status.js';
import { errorMessage } from '../../utils/errors.js';
import { schtasks, errorDetail } from './schtasks-exec.js';

export const windowsManager: ServiceManager = {
  backend: 'task-scheduler',
  configKind: 'Task Scheduler task',

  install(name: ServiceName, opts: ServiceInstallOptions = {}): ServiceInstallOutcome {
    return installWindowsTask(name, opts);
  },

  uninstall(name: ServiceName): ServiceUninstallOutcome {
    return uninstallWindowsTask(name);
  },

  status(name: ServiceName): ServiceStatus {
    return windowsStatus(name);
  },

  upgrade(name: ServiceName, opts: ServiceInstallOptions = {}): ServiceUpgradeOutcome {
    const xmlPath = taskXmlPath(name);
    const label = taskName(name);
    if (!existsSync(xmlPath)) {
      return { kind: 'not-installed', configPath: xmlPath };
    }
    let newXml: string;
    try {
      newXml = renderWindowsTask(name, opts);
    } catch (err) {
      return { kind: 'failed', reason: errorMessage(err) };
    }
    const current = readTaskFile(name);
    if (current === newXml) {
      return { kind: 'already-current', configPath: xmlPath, label };
    }
    const writeErr = writeUtf16Le(xmlPath, newXml);
    if (writeErr) return { kind: 'failed', reason: writeErr };
    try {
      schtasks(['/Create', '/TN', label, '/XML', xmlPath, '/F']);
    } catch (err) {
      return { kind: 'failed', reason: `schtasks /Create /F failed: ${errorDetail(err)}` };
    }
    return { kind: 'upgraded', configPath: xmlPath, label };
  },

  restart(name: ServiceName, opts?: ServiceInstallOptions): ServiceRestartOutcome {
    const xmlPath = taskXmlPath(name);
    const label = taskName(name);
    if (!existsSync(xmlPath)) {
      return { kind: 'not-installed', configPath: xmlPath };
    }

    // Per the ServiceManager.restart docstring: attempt to upgrade the
    // on-disk task XML before restarting so that any config changes take
    // effect. A failed upgrade is non-fatal — we surface it as a warning
    // and continue with the restart against the existing XML.
    const notes: string[] = [];
    const upgradeResult = windowsManager.upgrade(name, opts ?? {});
    if (upgradeResult.kind === 'failed') {
      notes.push(`[afk:service] upgrade before restart failed: ${upgradeResult.reason}`);
    }

    // End best-effort (may fail if not running — that's fine).
    try { schtasks(['/End', '/TN', label]); } catch { /* ignore */ }
    try {
      schtasks(['/Run', '/TN', label]);
      return notes.length > 0 ? { kind: 'restarted', label, notes } : { kind: 'restarted', label };
    } catch (err) {
      return { kind: 'failed', reason: `schtasks /Run failed: ${errorDetail(err)}` };
    }
  },

  isInstalled(name: ServiceName): boolean {
    return existsSync(taskXmlPath(name));
  },

  configPath(name: ServiceName): string {
    return taskXmlPath(name);
  },

  logPath(name: ServiceName): string {
    return serviceLogPath(name);
  },

  label(name: ServiceName): string {
    return taskName(name);
  },

  readConfigFile(name: ServiceName): string | undefined {
    return readTaskFile(name);
  },
};
