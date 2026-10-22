import { spawn } from 'child_process';
import { Command } from 'commander';
import { resolveNpmCli } from '../../utils/npm-cli.js';
import { palette } from '../palette.js';
import { getVersion } from '../version.js';
import {
  fetchLatestVersion,
  writePendingUpdateMarker,
  writeUpdateCache,
} from '../update-checker.js';
import { isNewerVersion } from '../update-version.js';

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\da-z.]+)?$/i;

export { resolveNpmCli } from '../../utils/npm-cli.js';

/** Foreground installation with visible npm output; `upgrade` is an alias. */
export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .alias('upgrade')
    .description('Update agent-afk to the latest published version')
    .option('--check', 'Only check whether an update is available; do not install')
    .option('--pin <version>', 'Install a specific version instead of latest (must be valid semver)')
    .option('--no-restart', 'Skip install lifecycle scripts and forced service restarts (idle version watchdogs remain active)')
    .action(async (opts: { check?: boolean; pin?: string; restart?: boolean }) => {
      const current = getVersion();

      // --check: report status only, never shell out to npm.
      if (opts.check === true) {
        process.stderr.write('Checking for updates…\n');
        const latest = await fetchLatestVersion();
        if (latest === undefined) {
          console.log(palette.warning('Could not reach the npm registry to check for updates.'));
          console.log(palette.dim(`  Current: ${current}`));
          process.exitCode = 1;
          return;
        }
        // Keep the passive notifier's cache in sync with the live probe.
        writeUpdateCache(latest);
        if (isNewerVersion(current, latest)) {
          console.log(`${palette.bold('Update available:')} ${palette.dim(current)} → ${palette.bold(latest)}`);
          console.log(palette.dim('  Run `afk update` to install.'));
          return;
        }
        console.log(`agent-afk ${palette.bold(current)} is up to date.`);
        return;
      }

      if (opts.pin !== undefined && !SEMVER_RE.test(opts.pin)) {
        console.error(palette.warning(`Invalid version: ${JSON.stringify(opts.pin)}. Must be valid semver (e.g. 1.2.3 or 1.2.3-beta.1).`));
        process.exitCode = 1;
        return;
      }

      let target: string | undefined = opts.pin;
      if (target === undefined) {
        process.stderr.write('Fetching latest version…\n');
        target = await fetchLatestVersion();
        if (target === undefined) {
          console.error(palette.warning('Could not reach the npm registry. Aborting.'));
          process.exitCode = 1;
          return;
        }
        // Explicit pins may be older and must not poison the notifier cache.
        writeUpdateCache(target);
        if (target === current) {
          console.log(`agent-afk ${palette.bold(current)} is up to date.`);
          return;
        }
      }

      const npmCli = resolveNpmCli();
      if (npmCli === undefined) {
        console.error(palette.warning('Could not locate npm in the running Node installation. Aborting rather than using a different global prefix.'));
        process.exitCode = 1;
        return;
      }
      console.log(`Updating agent-afk: ${palette.dim(current)} → ${palette.bold(target)}`);

      const { code, signal } = await runNpmInstall(target, npmCli, opts.restart !== false);
      if (code === 0) {
        writePendingUpdateMarker(target);
        console.log(palette.success(`✓ agent-afk@${target} installed.`));
        // Invariant: this process retains the OLD service renderer after npm
        // replaces the package. Never restart through its in-memory manager.
        // The installed package's postinstall owns macOS daemon reconciliation;
        // Telegram retains its idle-aware version watchdog. Other backends and
        // failed lifecycle restarts require an explicit new CLI invocation.
        console.log(palette.dim(opts.restart === false
          ? '  Install lifecycle scripts skipped; no forced service restarts. Idle version watchdogs remain active.'
          : '  Telegram updates through its idle-aware watchdog. If a service remains on the old version, run `afk service restart <name>` when idle.'));
      } else if (signal !== null) {
        console.error(palette.warning(`npm install was killed by signal ${signal}.`));
        process.exitCode = 1;
      } else {
        console.error(palette.warning(`npm install exited with code ${code ?? 1}.`));
        process.exitCode = code ?? 1;
      }
    });
}

interface ExitResult { code: number | null; signal: NodeJS.Signals | null }

function runNpmInstall(version: string, npmCli: string, restart: boolean): Promise<ExitResult> {
  return new Promise((resolve) => {
    // Invariant: npm executes lifecycle scripts before returning to the updater.
    // --ignore-scripts prevents postinstall restarts even for older pinned
    // releases that cannot honor a newly introduced AFK suppression variable.
    // Normal installs keep npm >=11.19's explicit lifecycle allowlist.
    const args = [npmCli, 'install', '-g', '--allow-scripts=agent-afk'];
    if (!restart) args.push('--ignore-scripts');
    args.push(`agent-afk@${version}`);
    console.log(palette.dim(`  ${process.execPath} ${args.join(' ')}`));
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('error', () => resolve({ code: 1, signal: null }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}
