/**
 * Windows Task Scheduler install / uninstall I/O — the win32 analog of
 * `systemd/install.ts` and `launchd/install.ts`.
 *
 * Argv comes from `./argv.ts` (win32-aware: the daemon runs the current
 * CLI script under `process.execPath`, not a POSIX-resolved `afk` binary).
 * No PATH is injected — an InteractiveToken task inherits the user's env.
 *
 * Task XML is written as UTF-16LE with a BOM (required by `schtasks /XML`).
 * Atomic write is done via a temp file + rename (same as atomic-write util).
 *
 * @module service/windows/install
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir, userInfo } from 'os';
import { dirname } from 'path';
import type { ServiceInstallOptions, ServiceInstallOutcome, ServiceName, ServiceUninstallOutcome } from '../types.js';
import { resolveWindowsProgramArguments } from './argv.js';
import { serviceLogPath, taskName, taskXmlPath } from './paths.js';
import { renderTaskXml } from './task-xml.js';
import { errorMessage } from '../../utils/errors.js';
import { schtasks, errorDetail } from './schtasks-exec.js';

/** Internal install opts — adds a test seam for the neutral options. */
export interface WindowsInstallOptions extends ServiceInstallOptions {
  /**
   * Override the `existsSync` used to validate the resolved entrypoint.
   * For tests that stub the telegram manager to return a fake path.
   */
  _entrypointExistsCheck?: (p: string) => boolean;
}

/**
 * Write a UTF-16LE file with BOM atomically (temp + rename).
 * `schtasks /XML` requires UTF-16LE encoding with a BOM.
 * Returns an error string on failure.
 */
export function writeUtf16Le(path: string, content: string): string | undefined {
  let tmpPath: string | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Same directory as the target so renameSync never crosses volumes (EXDEV).
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    tmpPath = tmp;
    // UTF-16LE BOM + content encoded as UTF-16LE.
    const bom = '\uFEFF';
    const buf = Buffer.from(bom + content, 'utf16le');
    writeFileSync(tmp, buf, { mode: 0o600 });
    renameSync(tmp, path);
    return undefined;
  } catch (err) {
    if (tmpPath) {
      try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    }
    return `Failed to write task XML at ${path}: ${errorMessage(err)}`;
  }
}

/**
 * Render the task XML for a service from the current code + environment.
 * Shared by install and `windowsManager.upgrade` so both produce
 * byte-identical output. Throws when argv resolution fails.
 */
export function renderWindowsTask(name: ServiceName, opts: WindowsInstallOptions = {}): string {
  const args = resolveWindowsProgramArguments(name, { existsCheck: opts._entrypointExistsCheck });
  return renderTaskXml({
    label: taskName(name),
    userId: userInfo().username,
    programArguments: args,
    workingDirectory: homedir(),
    logFile: serviceLogPath(name),
    environmentVariables: opts.environment,
  });
}

/**
 * Check whether the task is registered in the scheduler (query succeeds).
 * Returns true if `schtasks /Query /TN <name>` exits 0.
 */
function isTaskRegistered(name: ServiceName): boolean {
  try {
    schtasks(['/Query', '/TN', taskName(name), '/FO', 'LIST']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the XML task file and register it with `schtasks /Create /XML`.
 * Starts the task immediately with `schtasks /Run /TN`.
 * Rolls back the XML file on any schtasks failure.
 */
export function installWindowsTask(name: ServiceName, opts: WindowsInstallOptions = {}): ServiceInstallOutcome {
  const xmlPath = taskXmlPath(name);
  const label = taskName(name);

  // already-installed: XML copy exists AND task is registered.
  if (existsSync(xmlPath) && isTaskRegistered(name)) {
    return { kind: 'already-installed', configPath: xmlPath, label };
  }

  let xml: string;
  try {
    xml = renderWindowsTask(name, opts);
  } catch (err) {
    return { kind: 'failed', reason: errorMessage(err) };
  }
  mkdirSync(dirname(serviceLogPath(name)), { recursive: true });

  const writeErr = writeUtf16Le(xmlPath, xml);
  if (writeErr) return { kind: 'failed', reason: writeErr };

  if (opts.dryRun) {
    return {
      kind: 'installed',
      configPath: xmlPath,
      label,
      autoRestartOnRebuild: false,
      notes: [
        `(dry-run) schtasks was skipped; task is NOT yet registered.`,
        `Register manually: schtasks /Create /TN "${label}" /XML "${xmlPath}" /F`,
      ],
    };
  }

  try {
    schtasks(['/Create', '/TN', label, '/XML', xmlPath, '/F']);
  } catch (err) {
    rmSync(xmlPath, { force: true });
    return { kind: 'failed', reason: `schtasks /Create failed: ${errorDetail(err)}` };
  }

  // Start immediately (best-effort; ignore if already running).
  try {
    schtasks(['/Run', '/TN', label]);
  } catch {
    // Non-fatal: task is registered and will start on next logon trigger.
  }

  return {
    kind: 'installed',
    configPath: xmlPath,
    label,
    autoRestartOnRebuild: false,
    notes: [
      `Task registered as ${label}. It will auto-start on next login and restart on crash (RestartOnFailure).`,
    ],
  };
}

/**
 * Stop the task (best-effort), deregister it, and remove the XML copy.
 */
export function uninstallWindowsTask(name: ServiceName): ServiceUninstallOutcome {
  const xmlPath = taskXmlPath(name);
  const label = taskName(name);

  if (!existsSync(xmlPath) && !isTaskRegistered(name)) {
    return { kind: 'not-installed', configPath: xmlPath };
  }

  // End the task first (best-effort — may fail if not running).
  try {
    schtasks(['/End', '/TN', label]);
  } catch { /* ignore */ }

  // Delete the task from the scheduler.
  try {
    schtasks(['/Delete', '/TN', label, '/F']);
  } catch (err) {
    return { kind: 'failed', reason: `schtasks /Delete failed: ${errorDetail(err)}` };
  }

  // Remove the XML copy.
  try {
    if (existsSync(xmlPath)) rmSync(xmlPath, { force: true });
  } catch (err) {
    return { kind: 'failed', reason: `Failed to remove task XML: ${errorMessage(err)}` };
  }

  return { kind: 'uninstalled', configPath: xmlPath };
}

/** Read the on-disk XML task file contents (decoded from UTF-16LE). */
export function readTaskFile(name: ServiceName): string | undefined {
  const xmlPath = taskXmlPath(name);
  if (!existsSync(xmlPath)) return undefined;
  const buf = readFileSync(xmlPath);
  // Strip UTF-16LE BOM (0xFF 0xFE) if present.
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString('utf16le');
  }
  return buf.toString('utf16le');
}
