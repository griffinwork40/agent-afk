/**
 * systemd `--user` install / uninstall I/O — the Linux analog of
 * `launchd/install.ts`.
 *
 * Reuses the platform-neutral binary/entrypoint resolvers from
 * `../launchd/plist.js` (`resolveProgramArguments`, `resolveServicePath`,
 * `resolveWatchPaths`) — they resolve node/afk/the telegram entrypoint and
 * build the injected PATH with zero launchctl coupling, so both backends
 * share them. (A future refactor may hoist them to `service/resolve.ts`.)
 *
 * @module service/systemd/install
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname } from 'path';
import type { ServiceInstallOptions, ServiceInstallOutcome, ServiceName, ServiceUninstallOutcome } from '../types.js';
import { resolveProgramArguments, resolveServicePath, resolveWatchPaths } from '../launchd/plist.js';
import {
  SYSTEMCTL_TIMEOUT_MS,
  pathUnitFileName,
  pathUnitPath,
  serviceLogPath,
  systemdUserDir,
  unitFileName,
  unitPath,
} from './paths.js';
import { renderPathUnit, renderServiceUnit } from './unit.js';

/** Internal install opts — adds a test seam over the neutral options. */
export interface SystemdInstallOptions extends ServiceInstallOptions {
  /**
   * Override the `existsSync` used to validate the resolved entrypoint
   * before writing the unit. For tests that stub the telegram manager to
   * return a fake path. Production callers omit it.
   */
  _entrypointExistsCheck?: (p: string) => boolean;
}

/** Run a `systemctl --user` subcommand, surfacing stderr on failure. */
function systemctlUser(args: string[]): void {
  execFileSync('systemctl', ['--user', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SYSTEMCTL_TIMEOUT_MS,
  });
}

/** Extract the most actionable message from an execFileSync error. */
function errorDetail(err: unknown): string {
  const stderr = (err as { stderr?: Buffer | string }).stderr;
  const text = stderr ? stderr.toString().trim() : '';
  return text || (err as Error).message;
}

/**
 * Atomic file write: tmp sibling with `O_EXCL` (`flag: 'wx'`) + explicit
 * `mode: 0o600` (unit files may embed API keys/tokens via Environment=),
 * then `renameSync` into place. Mirrors the launchd installer's threat
 * model — see `launchd/install.ts`. Returns an error string on failure.
 */
function atomicWrite(path: string, content: string): string | undefined {
  const tmpPath = `${path}.tmp`;
  try {
    writeFileSync(tmpPath, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
  } catch (err) {
    return `Failed to write unit (tmp ${tmpPath}): ${(err as Error).message}`;
  }
  try {
    renameSync(tmpPath, path);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore — the rename error is the actionable one.
    }
    return `Failed to install unit (rename ${tmpPath} → ${path}): ${(err as Error).message}`;
  }
  return undefined;
}

const LINGER_NOTE =
  "Always-on across logout/reboot needs lingering: run 'loginctl enable-linger' (or 'sudo loginctl enable-linger <user>').";

/**
 * Write the `.service` unit (and, for dev-tree installs, a companion
 * `.path` unit) and register it with `systemctl --user`.
 *
 * Constraint ordering: the unit file MUST exist on disk before
 * `systemctl --user daemon-reload` + `enable --now`, otherwise enable
 * fails with "unit not found". So write → daemon-reload → enable, never
 * the inverse.
 */
export function installSystemdService(name: ServiceName, opts: SystemdInstallOptions = {}): ServiceInstallOutcome {
  const path = unitPath(name);
  if (existsSync(path)) {
    return { kind: 'already-installed', configPath: path, label: unitFileName(name) };
  }

  let args: string[];
  try {
    args = resolveProgramArguments(name, opts._entrypointExistsCheck);
  } catch (err) {
    return { kind: 'failed', reason: (err as Error).message };
  }
  const watchPaths = opts.noWatch ? undefined : resolveWatchPaths(name, opts._entrypointExistsCheck);
  const logFile = serviceLogPath(name);

  mkdirSync(systemdUserDir(), { recursive: true });
  mkdirSync(dirname(logFile), { recursive: true });

  // A `--user` unit does not inherit an interactive shell's PATH; inject
  // one led by the installer's node dir so a `#!/usr/bin/env node` shebang
  // resolves (same failure launchd's minimal bootstrap PATH causes).
  // Caller-supplied env wins.
  const environmentVariables: Record<string, string> = {
    PATH: resolveServicePath(),
    ...(opts.environment ?? {}),
  };

  const unit = renderServiceUnit({
    description: `AFK ${name} service`,
    execStart: args,
    workingDirectory: homedir(),
    logFile,
    environmentVariables,
  });
  const serviceWriteErr = atomicWrite(path, unit);
  if (serviceWriteErr) return { kind: 'failed', reason: serviceWriteErr };

  let pathUnitActive = false;
  if (watchPaths && watchPaths.length > 0) {
    const pathUnit = renderPathUnit({
      description: `AFK ${name} rebuild watch`,
      pathModified: watchPaths,
      unit: unitFileName(name),
    });
    const pathWriteErr = atomicWrite(pathUnitPath(name), pathUnit);
    if (pathWriteErr) {
      // Roll back the service unit so a half-install doesn't linger.
      rmSync(path, { force: true });
      return { kind: 'failed', reason: pathWriteErr };
    }
    pathUnitActive = true;
  }

  if (opts.dryRun) {
    return {
      kind: 'installed',
      configPath: path,
      label: unitFileName(name),
      autoRestartOnRebuild: pathUnitActive,
      notes: [
        `(dry-run) systemctl was skipped; service is NOT yet running.`,
        `Load manually: systemctl --user daemon-reload && systemctl --user enable --now ${unitFileName(name)}`,
        LINGER_NOTE,
      ],
    };
  }

  try {
    systemctlUser(['daemon-reload']);
    systemctlUser(['enable', '--now', unitFileName(name)]);
    if (pathUnitActive) {
      systemctlUser(['enable', '--now', pathUnitFileName(name)]);
    }
  } catch (err) {
    return { kind: 'failed', reason: `systemctl enable failed: ${errorDetail(err)}` };
  }

  return {
    kind: 'installed',
    configPath: path,
    label: unitFileName(name),
    autoRestartOnRebuild: pathUnitActive,
    notes: [LINGER_NOTE],
  };
}

/**
 * Disable the unit(s) and remove the unit file(s).
 *
 * Constraint ordering: `systemctl --user disable --now` MUST run before
 * `rm` of the unit file, otherwise we leave a phantom-loaded job whose
 * unit is gone. So disable → rm → daemon-reload.
 */
export function uninstallSystemdService(name: ServiceName): ServiceUninstallOutcome {
  const path = unitPath(name);
  if (!existsSync(path)) {
    return { kind: 'not-installed', configPath: path };
  }
  const pPath = pathUnitPath(name);
  const hadPathUnit = existsSync(pPath);

  // disable failures are usually "not loaded" — non-fatal; keep going so
  // the files get removed either way.
  try {
    if (hadPathUnit) systemctlUser(['disable', '--now', pathUnitFileName(name)]);
  } catch {
    // ignore
  }
  try {
    systemctlUser(['disable', '--now', unitFileName(name)]);
  } catch {
    // ignore
  }

  try {
    rmSync(path, { force: true });
    if (hadPathUnit) rmSync(pPath, { force: true });
  } catch (err) {
    return { kind: 'failed', reason: `Failed to remove unit: ${(err as Error).message}` };
  }

  // Best-effort reload so systemd forgets the removed unit immediately.
  try {
    systemctlUser(['daemon-reload']);
  } catch {
    // ignore
  }
  return { kind: 'uninstalled', configPath: path };
}

/** Read the on-disk `.service` unit contents, if installed. */
export function readUnitFile(name: ServiceName): string | undefined {
  const path = unitPath(name);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf-8');
}
