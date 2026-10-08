import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { Command } from 'commander';
import { palette } from '../palette.js';
import { getVersion } from '../version.js';
import {
  fetchLatestVersion,
  writePendingUpdateMarker,
  writeUpdateCache,
} from '../update-checker.js';
import { isNewerVersion } from '../update-version.js';
import { serviceManagerFor } from '../../service/index.js';
import type { ServiceName } from '../../service/index.js';

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\da-z.]+)?$/i;

/**
 * Resolve the `npm` binary that belongs to the SAME Node installation as the
 * currently-running `node` process. This avoids the version-skew bug where
 * `npm` on PATH belongs to a different prefix (e.g. nvm node on interactive
 * PATH vs. Homebrew node running launchd services), causing the update to
 * land in the wrong global prefix.
 *
 * Search order (fix A):
 *   1. `npm` / `npm.cmd` in `dirname(process.execPath)` — same prefix as this Node.
 *   2. `npm` on PATH as a fallback (preserves previous behaviour when 1 is absent).
 *
 * Pure and injectable for tests.
 */
export function resolveNpmBinary(
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
  existsFn: (p: string) => boolean = existsSync,
): string {
  const npmName = platform === 'win32' ? 'npm.cmd' : 'npm';
  const sibling = join(dirname(execPath), npmName);
  if (existsFn(sibling)) return sibling;
  return npmName; // fall back to PATH
}

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
    .option('--no-restart', 'Skip restarting installed services after a successful update')
    .action(async (opts: { check?: boolean; pin?: string; restart?: boolean }) => {
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

      // Fix A: use the npm that lives next to the running Node binary so the
      // update installs into the same global prefix as the running `afk`.
      const npmBin = resolveNpmBinary();
      console.log(`Updating agent-afk: ${palette.dim(current)} → ${palette.bold(target)}`);
      console.log(palette.dim(`  ${npmBin} install -g --allow-scripts=agent-afk agent-afk@${target}`));

      const { code, signal } = await runNpmInstall(target, npmBin);
      if (code === 0) {
        // Drop a pending-update marker so the next `afk` invocation prints
        // a confirmation line when it sees the version has bumped.
        writePendingUpdateMarker(target);
        console.log(palette.success(`✓ agent-afk@${target} installed.`));

        // Fix B: restart installed services so they pick up the new code.
        // A long-running Node process keeps the OLD module graph in memory
        // after npm overwrites the files on disk; only a restart swaps it.
        // Skip when --no-restart is passed or on unsupported platforms.
        if (opts.restart !== false) {
          restartServices();
        }
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

function runNpmInstall(version: string, npmBin: string): Promise<ExitResult> {
  return new Promise((resolve) => {
    // --allow-scripts=agent-afk is required on npm >=11.19 (bundled with
    // Node 24.21.0+), which began enforcing the allow-scripts gate and
    // silently skipping postinstall when the package is not explicitly
    // allowed. The flag was introduced in npm 7 and agent-afk requires
    // Node >=22.13 (npm >=10), so the flag is always safe to pass.
    // Inherit stdio so the user sees npm's progress, prompts, and errors.
    const child = spawn(
      npmBin,
      ['install', '-g', '--allow-scripts=agent-afk', `agent-afk@${version}`],
      { stdio: 'inherit' },
    );
    child.on('error', () => resolve({ code: 1, signal: null }));
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

/**
 * Restart each INSTALLED AFK service via the platform-agnostic service
 * manager (fix B). A failed restart must NOT mark the update itself as
 * failed — it prints a loud warning and sets a nonzero exit code so the
 * operator knows to intervene, but the installed files are already correct.
 *
 * Invariant: respects INV-018 — upgrade() is called by the manager's
 * restart() implementation internally; we do not call launchctl/systemctl
 * directly here.
 */
function restartServices(): void {
  const manager = serviceManagerFor();
  if (manager === null) {
    // Platform has no service backend — nothing to restart.
    return;
  }

  const services: ServiceName[] = ['daemon', 'telegram'];
  let anyRestartFailed = false;

  for (const name of services) {
    if (!manager.isInstalled(name)) continue;

    console.log(palette.dim(`  ↻ Restarting ${name} service…`));
    const result = manager.restart(name);

    if (result.kind === 'restarted') {
      console.log(palette.success(`  ✓ ${name} service restarted.`));
      if (result.notes && result.notes.length > 0) {
        for (const note of result.notes) {
          console.warn(palette.warning(`  ⚠ ${note}`));
        }
      }
    } else if (result.kind === 'not-installed') {
      // isInstalled() returned true but restart says not-installed — race
      // condition or plist was removed between the two calls. Non-fatal.
      console.warn(palette.warning(`  ⚠ ${name} service not found during restart — skipped.`));
    } else {
      // Restart failed. Warn loudly; do NOT mark the update as failed.
      // History: this code path mirrors the ETIMEDOUT incident (#3298) where
      // launchctl bootout timed out and left the service STOPPED rather than
      // running on old code — the service may be stopped OR still on the old
      // version depending on where in the restart sequence the failure occurred.
      const reason = result.reason;
      console.error(
        palette.warning(
          `\n⚠ WARNING: ${name} service restart failed: ${reason}\n` +
          `  The update installed successfully, but the ${name} service may be stopped\n` +
          `  or still running the old version. To apply the update manually, run:\n` +
          `    afk service restart ${name}\n` +
          `  If restart continues to fail, try:\n` +
          `    afk service uninstall ${name} && afk service install ${name}\n`,
        ),
      );
      anyRestartFailed = true;
    }
  }

  if (anyRestartFailed && !process.exitCode) {
    // Service restart failure warrants a nonzero exit so CI/automation
    // notices, but the update itself succeeded — use a distinct code.
    // Covers both 0 and undefined (update path never explicitly sets exitCode
    // on success, so process.exitCode may be undefined rather than 0).
    process.exitCode = 2;
  }
}
