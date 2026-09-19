/**
 * Platform-neutral service-manager contract.
 *
 * AFK installs its long-running processes (the Telegram bot, the daemon)
 * as OS-supervised services so they survive logout, reboot, OOM, and
 * crash. macOS uses launchd LaunchAgents; Linux uses systemd `--user`
 * units. This module defines the backend-agnostic interface both
 * implementations satisfy, plus the neutral result shapes the CLI renders.
 *
 * Why a neutral layer: `src/cli/commands/service.ts` used to import the
 * launchd free-functions directly and hard-throw on non-darwin. That
 * coupled the whole `afk service` surface to macOS. The `ServiceManager`
 * interface here + the `serviceManagerFor(platform)` factory in
 * `./index.ts` replace that single darwin gate with a platform dispatch,
 * mirroring the injected-`platform` pattern `src/cli/clipboard.ts` uses.
 *
 * The launchd backend keeps its own launchd-flavoured result types
 * (`plistPath` fields, etc.) unchanged — a thin adapter
 * (`./launchd/manager.ts`) maps them onto these neutral shapes, so the
 * existing launchd test-suite is untouched.
 *
 * @module service/types
 */

import { join } from 'path';
import { getLogsDir } from '../paths.js';

/**
 * Service kinds AFK can register. Mirrors `launchd/paths.ts`'s ServiceName
 * (kept as a separate declaration so the launchd module and its test-suite
 * stay byte-stable); the two 2-member unions are structurally identical
 * and freely assignable.
 */
export type ServiceName = 'telegram' | 'daemon';

/** All recognised service names. Single source of truth for CLI validation. */
export const SERVICE_NAMES: readonly ServiceName[] = ['telegram', 'daemon'];

/** Options accepted by {@link ServiceManager.install}. */
export interface ServiceInstallOptions {
  /** Disable auto-restart-on-rebuild even if the dev-tree heuristic would enable it. */
  noWatch?: boolean;
  /** Write the unit/plist file but do NOT register it with the supervisor. */
  dryRun?: boolean;
  /** Extra environment variables to bake into the unit/plist. */
  environment?: Record<string, string>;
}

/** Outcome of {@link ServiceManager.install}. */
export type ServiceInstallOutcome =
  | {
      kind: 'installed';
      /** Absolute path of the written config (LaunchAgent plist or systemd unit). */
      configPath: string;
      label: string;
      /** True when the backend emitted an auto-restart-on-rebuild trigger (launchd WatchPaths / systemd .path unit). */
      autoRestartOnRebuild: boolean;
      /** Backend-specific post-install advice for the operator (e.g. enable lingering). */
      notes?: string[];
    }
  | { kind: 'already-installed'; configPath: string; label: string }
  | { kind: 'failed'; reason: string };

/** Outcome of {@link ServiceManager.uninstall}. */
export type ServiceUninstallOutcome =
  | { kind: 'uninstalled'; configPath: string }
  | { kind: 'not-installed'; configPath: string }
  | { kind: 'failed'; reason: string };

/** Outcome of {@link ServiceManager.restart}. */
export type ServiceRestartOutcome =
  | {
      kind: 'restarted';
      label: string;
      /**
       * Non-fatal warnings from the restart sequence (e.g. the plist upgrade
       * step failed but the kickstart still succeeded). Callers should surface
       * these to the user so silent partial failures are visible.
       */
      notes?: string[];
    }
  | { kind: 'not-installed'; configPath: string }
  | { kind: 'failed'; reason: string };

/** Outcome of {@link ServiceManager.upgrade}. */
export type ServiceUpgradeOutcome =
  | { kind: 'upgraded'; configPath: string; label: string }
  | { kind: 'already-current'; configPath: string; label: string }
  | { kind: 'not-installed'; configPath: string }
  | { kind: 'failed'; reason: string };

/** Neutral status snapshot rendered by `afk service status`. */
export interface ServiceStatus {
  name: ServiceName;
  label: string;
  installed: boolean;
  /** Absolute path of the config file (LaunchAgent plist or systemd unit). */
  configPath: string;
  /** Running PID if the supervisor reports the job as loaded with an active process. */
  pid?: number;
  /** Last exit status reported by the supervisor (0 = clean). */
  lastExitStatus?: number;
  /** Log file path AFK redirects the service's stdout+stderr to. */
  logFile: string;
}

/**
 * Backend-agnostic service supervisor. One implementation per platform:
 *   - `./launchd/manager.ts` (darwin)
 *   - `./systemd/manager.ts` (linux)
 *
 * Selected at the CLI boundary by `serviceManagerFor(process.platform)`.
 */
export interface ServiceManager {
  /** Which supervisor this manager drives. */
  readonly backend: 'launchd' | 'systemd';
  /** Human-readable name of the config artifact, for CLI copy ("LaunchAgent plist" / "systemd user unit"). */
  readonly configKind: string;

  install(name: ServiceName, opts?: ServiceInstallOptions): ServiceInstallOutcome;
  uninstall(name: ServiceName): ServiceUninstallOutcome;
  status(name: ServiceName): ServiceStatus;
  /**
   * Restart the named service.
   *
   * Side-effect: before restarting the process this method first calls
   * {@link upgrade} to ensure the on-disk config matches what the current
   * code would render. When the config was actually rewritten ('upgraded')
   * the supervisor is asked to reload from disk (bootout → bootstrap on
   * launchd; `daemon-reload` + `restart` on systemd) so new config keys take
   * effect immediately. When the config is already current a lighter-weight
   * process restart is used (kickstart -k / `restart` without daemon-reload).
   * If the upgrade step fails the restart still proceeds against the existing
   * on-disk config and the failure is surfaced as a warning in
   * {@link ServiceRestartOutcome.notes}.
   */
  restart(name: ServiceName, opts?: ServiceInstallOptions): ServiceRestartOutcome;

  /**
   * Re-render the service config from the current code and atomically
   * replace it if the on-disk file has drifted. Returns `already-current`
   * when the rendered config matches what is installed, so the caller can
   * skip an unnecessary restart.
   */
  upgrade(name: ServiceName, opts?: ServiceInstallOptions): ServiceUpgradeOutcome;

  /** Cheap installed-or-not check (config file present) without querying the supervisor. */
  isInstalled(name: ServiceName): boolean;
  /** Absolute path of the config file for a service. */
  configPath(name: ServiceName): string;
  /** Absolute path of the service's log file. */
  logPath(name: ServiceName): string;
  /** Reverse-DNS / unit label for a service. */
  label(name: ServiceName): string;
  /** Read the on-disk config file contents, if installed. */
  readConfigFile(name: ServiceName): string | undefined;
}

/**
 * Per-service log file path under `~/.afk/logs/`. Shared by both the launchd
 * and systemd backends so `afk service status` reports the same file path
 * regardless of platform.
 *
 * Both backends re-export this under their own backend-scoped name (e.g.
 * `serviceLogPath` in `launchd/paths.ts` and `systemd/paths.ts`) for
 * backward compatibility with existing callers.
 */
export function serviceLogPath(name: ServiceName): string {
  return join(getLogsDir(), `service-${name}.log`);
}

/**
 * Hard timeout cap shared by all supervisor invocations (`launchctl` on macOS,
 * `systemctl` on Linux). Both backends expose this under a backend-specific
 * name (`LAUNCHCTL_TIMEOUT_MS` / `SYSTEMCTL_TIMEOUT_MS`) as re-exports for
 * backward compatibility; new code should import this canonical constant.
 *
 * 8 seconds covers normal bootstrap/bootout (~50–500 ms) with generous
 * head-room for a slow XPC/DBus handshake, while still being well inside
 * user-perceptible "this is broken" territory.
 */
export const SERVICE_TIMEOUT_MS = 8_000;
