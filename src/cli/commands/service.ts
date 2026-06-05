/**
 * `afk service` command group — install AFK long-running processes as
 * macOS LaunchAgents so they auto-start on login and relaunch on crash.
 *
 * Subcommands:
 *   afk service install <name>     — write plist + bootstrap into launchctl
 *   afk service uninstall <name>   — bootout + remove plist
 *   afk service status [name]      — show running PID + last exit + log path
 *   afk service list               — show all services and whether installed
 *
 * `<name>` ∈ { telegram, daemon }. See `src/service/launchd.ts` for the
 * rationale on per-user scope (vs. system-wide LaunchDaemons), WatchPaths
 * auto-restart heuristics, and why launchd runs the entrypoints directly
 * instead of the `afk telegram start` / `afk daemon` CLI wrappers.
 *
 * @module cli/commands/service
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { palette } from '../palette.js';
import { handleCommandError } from '../errors/index.js';
import {
  SERVICE_NAMES,
  installService,
  labelFor,
  plistPath,
  serviceLogPath,
  serviceStatus,
  uninstallService,
  type ServiceName,
  type ServiceStatusSnapshot,
} from '../../service/launchd.js';

function assertMacOS(): void {
  if (process.platform !== 'darwin') {
    throw new Error(
      `'afk service' uses macOS launchd and is only supported on darwin. Detected: ${process.platform}.`,
    );
  }
}

function parseServiceName(input: string): ServiceName {
  const lower = input.toLowerCase();
  if ((SERVICE_NAMES as readonly string[]).includes(lower)) return lower as ServiceName;
  throw new Error(
    `Unknown service '${input}'. Supported: ${SERVICE_NAMES.join(', ')}.`,
  );
}

export function registerServiceCommand(program: Command): void {
  const service = program
    .command('service')
    .description('Manage AFK background services via macOS launchd (always-on, auto-restart)');

  service
    .command('install <name>')
    .description(`Install <${SERVICE_NAMES.join('|')}> as a LaunchAgent that starts on login and relaunches on crash`)
    .option('--no-watch', 'Disable WatchPaths (no auto-restart on rebuild)')
    .option('--dry-run', 'Write the plist but do not call launchctl', false)
    .action((nameArg: string, opts: { watch?: boolean; dryRun?: boolean }) => {
      try {
        assertMacOS();
        const name = parseServiceName(nameArg);
        const result = installService(name, {
          noWatch: opts.watch === false,
          skipBootstrap: Boolean(opts.dryRun),
        });
        if (result.kind === 'already-installed') {
          console.log(chalk.yellow(`⚠ ${result.label} already installed at ${result.plistPath}`));
          console.log(palette.meta(`  Run 'afk service uninstall ${name}' first to reinstall.`));
          process.exit(1);
        }
        if (result.kind === 'failed') {
          console.error(chalk.red(`✗ Install failed: ${result.reason}`));
          process.exit(1);
        }
        console.log(chalk.green(`✓ Installed ${result.label}`));
        console.log(palette.meta(`  Plist:   ${result.plistPath}`));
        console.log(palette.meta(`  Log:     ${serviceLogPath(name)}`));
        if (result.watchPathsActive) {
          console.log(palette.meta(`  WatchPaths: active — service auto-restarts on rebuild.`));
        } else {
          console.log(palette.meta(`  WatchPaths: off — manual 'afk service restart' needed after updates.`));
        }
        if (opts.dryRun) {
          // M-10: interpolate the real uid so the copy-paste command works
          // on this machine. `$(id -u)` would only expand inside a shell,
          // but we're printing a raw string to the terminal.
          const uid = process.getuid?.() ?? 501;
          console.log(palette.info(`  (dry-run) launchctl bootstrap was skipped; service is NOT yet running.`));
          console.log(palette.meta(`  Load manually: launchctl bootstrap gui/${uid} ${result.plistPath}`));
        } else {
          console.log(palette.meta(`  Status:  afk service status ${name}`));
        }
      } catch (err) {
        handleCommandError(err);
      }
    });

  service
    .command('uninstall <name>')
    .description('Stop the service and remove its LaunchAgent plist')
    .action((nameArg: string) => {
      try {
        assertMacOS();
        const name = parseServiceName(nameArg);
        const result = uninstallService(name);
        if (result.kind === 'not-installed') {
          console.log(chalk.yellow(`⚠ ${labelFor(name)} is not installed (no plist at ${result.plistPath})`));
          return;
        }
        if (result.kind === 'failed') {
          console.error(chalk.red(`✗ Uninstall failed: ${result.reason}`));
          process.exit(1);
        }
        console.log(chalk.green(`✓ Uninstalled ${labelFor(name)}`));
        console.log(palette.meta(`  Removed: ${result.plistPath}`));
      } catch (err) {
        handleCommandError(err);
      }
    });

  service
    .command('status [name]')
    .description('Show running PID, last exit status, and log file for one or all services')
    .action((nameArg: string | undefined) => {
      try {
        assertMacOS();
        if (nameArg) {
          const snapshot = serviceStatus(parseServiceName(nameArg));
          printStatus(snapshot);
          return;
        }
        for (const name of SERVICE_NAMES) {
          printStatus(serviceStatus(name));
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
        assertMacOS();
        console.log(chalk.bold('AFK services:'));
        for (const name of SERVICE_NAMES) {
          const path = plistPath(name);
          const installed = existsSync(path);
          const marker = installed ? chalk.green('●') : chalk.dim('○');
          const tag = installed ? palette.meta('installed') : palette.meta('not installed');
          console.log(`  ${marker} ${name.padEnd(10)}  ${tag}  ${palette.meta(path)}`);
        }
      } catch (err) {
        handleCommandError(err);
      }
    });

  service
    .command('restart <name>')
    .description('Restart the service (launchctl kickstart -k)')
    .action((nameArg: string) => {
      try {
        assertMacOS();
        const name = parseServiceName(nameArg);
        const path = plistPath(name);
        if (!existsSync(path)) {
          console.error(chalk.red(`✗ ${labelFor(name)} is not installed. Run 'afk service install ${name}' first.`));
          process.exit(1);
        }
        // We deliberately shell out here rather than wrap in launchd.ts:
        // restart is a one-line launchctl call and packaging it in
        // launchd.ts would proliferate I/O surface beyond the install
        // lifecycle that module is centred on.
        //
        // M-5: assert getuid is available rather than silently falling
        // back to a wrong uid (501). process.getuid is undefined on
        // Windows; on macOS this can never happen, but we make the
        // assumption explicit so the stack trace points here rather than
        // at a confusing launchctl error about a non-existent domain.
        if (typeof process.getuid !== 'function') {
          throw new Error(
            'process.getuid is unavailable — afk service restart requires a POSIX system.',
          );
        }
        const uid = process.getuid();
        try {
          execFileSync(
            'launchctl',
            ['kickstart', '-k', `gui/${uid}/${labelFor(name)}`],
            { stdio: ['ignore', 'pipe', 'pipe'], timeout: 8_000 },
          );
          console.log(chalk.green(`✓ Restarted ${labelFor(name)}`));
        } catch (e) {
          console.error(chalk.red(`✗ Restart failed: ${(e as Error).message}`));
          process.exit(1);
        }
      } catch (err) {
        handleCommandError(err);
      }
    });
}

function printStatus(s: ServiceStatusSnapshot): void {
  console.log(chalk.bold(`${s.label}`));
  if (!s.installed) {
    console.log(`  ${chalk.dim('○')} Not installed`);
    console.log(palette.meta(`  Plist:   ${s.plistPath}`));
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
  console.log(palette.meta(`  Plist:   ${s.plistPath}`));
  console.log(palette.meta(`  Log:     ${s.logFile}`));
}
