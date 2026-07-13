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
  | { kind: 'restarted'; label: string }
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
  restart(name: ServiceName): ServiceRestartOutcome;

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
