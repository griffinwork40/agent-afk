/**
 * Windows Task Scheduler backend for the platform-neutral
 * {@link ServiceManager} contract (win32). Thin wiring over
 * `./install.ts`, `./status.ts`, and `schtasks /End` + `/Run`
 * for restart.
 *
 * @module service/windows/manager
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
import { SCHTASKS_TIMEOUT_MS, serviceLogPath, taskName, taskXmlPath } from './paths.js';
import { installWindowsTask, readTaskFile, renderWindowsTask, uninstallWindowsTask, writeUtf16Le } from './install.js';
import { windowsStatus } from './status.js';
import { errorMessage } from '../../utils/errors.js';

/** Run a `schtasks` command; extract stderr on failure. */
function schtasks(args: string[]): Buffer {
  return execFileSync('schtasks', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    timeout: SCHTASKS_TIMEOUT_MS,
  });
}

function errorDetail(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string }).stderr;
  const text = stderr ? stderr.toString().trim() : '';
  return text || errorMessage(err);
}

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

  restart(name: ServiceName, _opts?: ServiceInstallOptions): ServiceRestartOutcome {
    const xmlPath = taskXmlPath(name);
    const label = taskName(name);
    if (!existsSync(xmlPath)) {
      return { kind: 'not-installed', configPath: xmlPath };
    }
    // End best-effort (may fail if not running — that's fine).
    try { schtasks(['/End', '/TN', label]); } catch { /* ignore */ }
    try {
      schtasks(['/Run', '/TN', label]);
      return { kind: 'restarted', label };
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
