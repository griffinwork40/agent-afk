/**
 * `afk service` command group — install AFK long-running processes as
 * OS-supervised services so they auto-start on login and relaunch on
 * crash. Backend is chosen per platform by `serviceManagerFor()`:
 *   - macOS → launchd LaunchAgents (`~/Library/LaunchAgents/`)
 *   - Linux → systemd `--user` units (`~/.config/systemd/user/`)
 *
 * Subcommands:
 *   afk service install <name>     — write config + register with supervisor
 *   afk service uninstall <name>   — deregister + remove config
 *   afk service status [name]      — show running PID + last exit + log path
 *   afk service list               — show all services and whether installed
 *   afk service restart <name>     — restart the service
 *
 * `<name>` ∈ { telegram, daemon }. See `src/service/types.ts` for the
 * backend-neutral contract and `src/service/{launchd,systemd}/` for the
 * per-OS rationale (per-user scope, auto-restart heuristics, why the
 * entrypoints are run directly instead of the CLI wrappers).
 *
 * @module cli/commands/service
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { palette } from '../palette.js';
import { handleCommandError } from '../errors/index.js';
import {
  SERVICE_NAMES,
  SUPPORTED_SERVICE_PLATFORMS,
  serviceManagerFor,
  type ServiceManager,
  type ServiceName,
  type ServiceStatus,
} from '../../service/index.js';

/** Resolve the platform's service backend, or fail with a clear message. */
function resolveManager(): ServiceManager {
  const mgr = serviceManagerFor();
  if (!mgr) {
    throw new Error(
      `'afk service' is not supported on ${process.platform}. Supported: ${SUPPORTED_SERVICE_PLATFORMS}.`,
    );
  }
  return mgr;
}

function parseServiceName(input: string): ServiceName {
  const lower = input.toLowerCase();
  if ((SERVICE_NAMES as readonly string[]).includes(lower)) return lower as ServiceName;
  throw new Error(`Unknown service '${input}'. Supported: ${SERVICE_NAMES.join(', ')}.`);
}

export function registerServiceCommand(program: Command): void {
  const service = program
    .command('service')
    .description('Manage AFK background services (launchd on macOS, systemd --user on Linux) — always-on, auto-restart');

  service
    .command('install <name>')
    .description(`Install <${SERVICE_NAMES.join('|')}> as an OS service that starts on login and relaunches on crash`)
    .option('--no-watch', 'Disable auto-restart-on-rebuild (launchd WatchPaths / systemd .path unit)')
    .option('--dry-run', 'Write the config file but do not register with the supervisor', false)
    .action((nameArg: string, opts: { watch?: boolean; dryRun?: boolean }) => {
      try {
        const mgr = resolveManager();
        const name = parseServiceName(nameArg);
        const result = mgr.install(name, {
          noWatch: opts.watch === false,
          dryRun: Boolean(opts.dryRun),
        });
        if (result.kind === 'already-installed') {
          console.log(chalk.yellow(`⚠ ${result.label} already installed at ${result.configPath}`));
          console.log(palette.meta(`  Run 'afk service uninstall ${name}' first to reinstall.`));
          process.exit(1);
        }
        if (result.kind === 'failed') {
          console.error(chalk.red(`✗ Install failed: ${result.reason}`));
          process.exit(1);
        }
        console.log(chalk.green(`✓ Installed ${result.label}`));
        console.log(palette.meta(`  Config:  ${result.configPath}  (${mgr.configKind})`));
        console.log(palette.meta(`  Log:     ${mgr.logPath(name)}`));
        if (result.autoRestartOnRebuild) {
          console.log(palette.meta(`  Auto-restart on rebuild: on`));
        } else {
          console.log(palette.meta(`  Auto-restart on rebuild: off — run 'afk service restart ${name}' after updates.`));
        }
        for (const note of result.notes ?? []) {
          console.log(palette.info(`  ${note}`));
        }
        if (!opts.dryRun) {
          console.log(palette.meta(`  Status:  afk service status ${name}`));
        }
      } catch (err) {
        handleCommandError(err);
      }
    });

  service
    .command('uninstall <name>')
    .description('Stop the service and remove its config (LaunchAgent plist / systemd unit)')
    .action((nameArg: string) => {
      try {
        const mgr = resolveManager();
        const name = parseServiceName(nameArg);
        const result = mgr.uninstall(name);
        if (result.kind === 'not-installed') {
          console.log(chalk.yellow(`⚠ ${mgr.label(name)} is not installed (no config at ${result.configPath})`));
          return;
        }
        if (result.kind === 'failed') {
          console.error(chalk.red(`✗ Uninstall failed: ${result.reason}`));
          process.exit(1);
        }
        console.log(chalk.green(`✓ Uninstalled ${mgr.label(name)}`));
        console.log(palette.meta(`  Removed: ${result.configPath}`));
      } catch (err) {
        handleCommandError(err);
      }
    });

  service
    .command('status [name]')
    .description('Show running PID, last exit status, and log file for one or all services')
    .action((nameArg: string | undefined) => {
      try {
        const mgr = resolveManager();
        if (nameArg) {
          printStatus(mgr.status(parseServiceName(nameArg)), mgr.configKind);
          return;
        }
        for (const name of SERVICE_NAMES) {
          printStatus(mgr.status(name), mgr.configKind);
          console.log('');
        }
      } catch (err) {
        handleCommandError(err);
      }
    });

  service
    .command('list')
    .description('List recognised service names and whether each is installed')
    .action(() => {
      try {
        const mgr = resolveManager();
        console.log(chalk.bold(`AFK services (${mgr.backend}):`));
        for (const name of SERVICE_NAMES) {
          const installed = mgr.isInstalled(name);
          const marker = installed ? chalk.green('●') : chalk.dim('○');
          const tag = installed ? palette.meta('installed') : palette.meta('not installed');
          console.log(`  ${marker} ${name.padEnd(10)}  ${tag}  ${palette.meta(mgr.configPath(name))}`);
        }
      } catch (err) {
        handleCommandError(err);
      }
    });

  service
    .command('restart <name>')
    .description('Restart the service (launchctl kickstart -k / systemctl --user restart)')
    .action((nameArg: string) => {
      try {
        const mgr = resolveManager();
        const name = parseServiceName(nameArg);
        const result = mgr.restart(name);
        if (result.kind === 'not-installed') {
          console.error(chalk.red(`✗ ${mgr.label(name)} is not installed. Run 'afk service install ${name}' first.`));
          process.exit(1);
        }
        if (result.kind === 'failed') {
          console.error(chalk.red(`✗ Restart failed: ${result.reason}`));
          process.exit(1);
        }
        console.log(chalk.green(`✓ Restarted ${result.label}`));
      } catch (err) {
        handleCommandError(err);
      }
    });
}

function printStatus(s: ServiceStatus, configKind: string): void {
  console.log(chalk.bold(`${s.label}`));
  if (!s.installed) {
    console.log(`  ${chalk.dim('○')} Not installed`);
    console.log(palette.meta(`  Config:  ${s.configPath}  (${configKind})`));
    console.log(palette.meta(`  Install: afk service install ${s.name}`));
    return;
  }
  if (s.pid !== undefined) {
    console.log(`  ${chalk.green('●')} Running  (PID ${s.pid})`);
  } else {
    console.log(`  ${chalk.yellow('●')} Installed but not running`);
    if (s.lastExitStatus !== undefined && s.lastExitStatus !== 0) {
      console.log(palette.meta(`  Last exit status: ${s.lastExitStatus}`));
    }
  }
  console.log(palette.meta(`  Config:  ${s.configPath}  (${configKind})`));
  console.log(palette.meta(`  Log:     ${s.logFile}`));
}
