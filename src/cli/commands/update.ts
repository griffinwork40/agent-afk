import { spawn } from 'child_process';
import { Command } from 'commander';
import { palette } from '../palette.js';
import { getVersion } from '../version.js';
import {
  fetchLatestVersion,
  writePendingUpdateMarker,
  writeUpdateCache,
} from '../update-checker.js';
import { isNewerVersion } from '../update-version.js';

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\da-z.]+)?$/i;

/**
 * `afk update` runs an in-foreground `npm install -g agent-afk@<latest>` so the
 * user can actually see install output, error messages, and the npm progress
 * bar — instead of the silent background `triggerAutoUpdate` path used when
 * `updatePolicy` is `auto`.
 *
 * `afk upgrade` is registered as an alias.
 */
export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .alias('upgrade')
    .description('Update agent-afk to the latest published version')
    .option('--check', 'Only check whether an update is available; do not install')
    .option('--pin <version>', 'Install a specific version instead of latest (must be valid semver)')
    .action(async (opts: { check?: boolean; pin?: string }) => {
      const current = getVersion();

      // --check: report status only, never shell out to npm.
      if (opts.check === true) {
        // Fetch synchronously — do NOT rely on the stale cache since the user
        // explicitly asked for a current status.  Also suppress the background
        // check that checkForUpdates() would otherwise spawn concurrently.
        process.stderr.write('Checking for updates…\n');
        const latest = await fetchLatestVersion();
        if (latest === undefined) {
          console.log(palette.warning('Could not reach the npm registry to check for updates.'));
          console.log(palette.dim(`  Current: ${current}`));
          process.exitCode = 1;
          return;
        }
        // Keep the passive notifier's cache in sync with what we just learned
        // from the registry, so the startup banner doesn't render from a stale
        // latestVersion after the user has explicitly checked.
        writeUpdateCache(latest);
        if (isNewerVersion(current, latest)) {
          console.log(`${palette.bold('Update available:')} ${palette.dim(current)} → ${palette.bold(latest)}`);
          console.log(palette.dim('  Run `afk update` to install.'));
          return;
        }
        console.log(`agent-afk ${palette.bold(current)} is up to date.`);
        return;
      }

      // Validate --pin value before it reaches the shell.
      if (opts.pin !== undefined && !SEMVER_RE.test(opts.pin)) {
        console.error(palette.warning(`Invalid version: ${JSON.stringify(opts.pin)}. Must be valid semver (e.g. 1.2.3 or 1.2.3-beta.1).`));
        process.exitCode = 1;
        return;
      }

      // Resolve target version: explicit --pin overrides the registry probe.
      let target: string | undefined = opts.pin;
      if (target === undefined) {
        process.stderr.write('Fetching latest version…\n');
        target = await fetchLatestVersion();
        if (target === undefined) {
          console.error(palette.warning('Could not reach the npm registry. Aborting.'));
          process.exitCode = 1;
          return;
        }
        // Refresh the notifier cache with the registry's current latest so the
        // banner is honest right after this update (only on the fetched path —
        // an explicit --pin may target an older version and must not poison it).
        writeUpdateCache(target);
        if (target === current) {
          console.log(`agent-afk ${palette.bold(current)} is up to date.`);
          return;
        }
      }

      console.log(`Updating agent-afk: ${palette.dim(current)} → ${palette.bold(target)}`);
      console.log(palette.dim(`  npm install -g --allow-scripts=agent-afk agent-afk@${target}`));

      const { code, signal } = await runNpmInstall(target);
      if (code === 0) {
        // Drop a pending-update marker so the next `afk` invocation prints
        // a confirmation line when it sees the version has bumped.
        writePendingUpdateMarker(target);
        console.log(palette.success(`✓ agent-afk@${target} installed.`));
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

function runNpmInstall(version: string): Promise<ExitResult> {
  return new Promise((resolve) => {
    // --allow-scripts=agent-afk is required on npm >=11.19 (bundled with
    // Node 24.21.0+), which began enforcing the allow-scripts gate and
    // silently skipping postinstall when the package is not explicitly
    // allowed. The flag was introduced in npm 7 and agent-afk requires
    // Node >=22.13 (npm >=10), so the flag is always safe to pass.
    // Inherit stdio so the user sees npm's progress, prompts, and errors.
    const child = spawn(
      'npm',
      ['install', '-g', '--allow-scripts=agent-afk', `agent-afk@${version}`],
      { stdio: 'inherit' },
    );
    child.on('error', () => resolve({ code: 1, signal: null }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}
