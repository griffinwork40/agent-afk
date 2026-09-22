/**
 * `afk worktree` command group.
 *
 * Subcommands:
 *   afk worktree list   — dry-run sweep with tabular output
 *   afk worktree prune  — remove stale/empty/orphaned worktrees
 *
 * @module cli/commands/worktree
 */

import { Command } from 'commander';
import { env } from '../../config/env.js';
import { palette } from '../palette.js';
import { execFile as execFileCallback } from 'node:child_process';
import { handleCommandError } from '../errors/index.js';
import { promisify } from 'node:util';
import { runSweep } from '../../agent/worktree/worktree-sweep.js';
import type { SweepOptions } from '../../agent/worktree/worktree-sweep.js';
import { loadConfig } from '../config.js';
import type { ExecFileFn } from '../../agent/worktree/worktree-sweep.js';
import { errorMessage } from '../../utils/errors.js';
import { resolveRepoRoot } from '../../utils/git.js';
import {
  formatAge,
  parseScope,
  verdictWouldPrune,
  buildVerdictTallyString,
} from '../../agent/worktree/display.js';
import type { Scope } from '../../agent/worktree/display.js';

const execFile = promisify(execFileCallback) as ExecFileFn;

export function registerWorktreeCommand(program: Command): void {
  const worktree = program
    .command('worktree')
    .description('Manage git worktrees created by afk');

  // ── afk worktree list ──────────────────────────────────────────────────
  worktree
    .command('list')
    .description('List all afk-managed worktrees and show prune candidates (dry-run only)')
    .action(async () => {
      let repoRoot: string;
      try {
        repoRoot = await resolveRepoRoot();
      } catch (err) {
        handleCommandError(err);
      }

      let result;
      try {
        result = await runSweep({
          execFile,
          repoRoot,
          dryRun: true,
        });
      } catch (err) {
        handleCommandError(new Error(`Sweep failed: ${errorMessage(err)}`));
      }

      const header = [
        'PATH'.padEnd(45),
        'OWNER'.padEnd(12),
        'AGE'.padEnd(6),
        'STATUS'.padEnd(22),
        'PRUNE?',
      ].join(' | ');
      console.log(palette.heading(header));
      console.log('-'.repeat(header.length));

      for (const c of result.candidates) {
        const row = [
          c.path.slice(-44).padEnd(45),
          c.owner.padEnd(12),
          formatAge(c.ageMs).padEnd(6),
          c.verdict.padEnd(22),
          verdictWouldPrune(c.verdict),
        ].join(' | ');
        console.log(row);
      }

      if (result.candidates.length === 0) {
        console.log(palette.dim('  (no afk-managed worktrees found)'));
      }

      if (result.warnings.length > 0) {
        console.log('');
        for (const w of result.warnings) {
          console.log(palette.warning(w));
        }
      }
    });

  // ── afk worktree prune ─────────────────────────────────────────────────
  worktree
    .command('prune')
    .description('Remove stale, empty, and orphaned worktrees')
    .option('--apply', 'Execute removals (default is dry-run)', false)
    .option('--max-age-days-clean <n>', 'Max age (days) for clean worktrees before removal')
    .option('--max-age-days-dirty <n>', 'Max age (days) for dirty worktrees before warning')
    .option('--scope <scope>', 'Scope: interactive | diagnose | all', 'all')
    .action(async (options: {
      apply: boolean;
      maxAgeDaysClean?: string;
      maxAgeDaysDirty?: string;
      scope: string;
    }) => {
      let repoRoot: string;
      try {
        repoRoot = await resolveRepoRoot();
      } catch (err) {
        handleCommandError(err);
      }

      const config = loadConfig();
      const pruneConfig = config.daemon?.worktreePrune;

      const envClean = parseInt(env.AFK_WORKTREE_MAX_AGE_CLEAN ?? '', 10);
      const envDirty = parseInt(env.AFK_WORKTREE_MAX_AGE_DIRTY ?? '', 10);

      const maxAgeDaysClean =
        options.maxAgeDaysClean !== undefined
          ? parseInt(options.maxAgeDaysClean, 10)
          : (pruneConfig?.maxAgeDaysClean ?? (Number.isNaN(envClean) ? 14 : envClean));

      const maxAgeDaysDirty =
        options.maxAgeDaysDirty !== undefined
          ? parseInt(options.maxAgeDaysDirty, 10)
          : (pruneConfig?.maxAgeDaysDirty ?? (Number.isNaN(envDirty) ? 30 : envDirty));

      let scopeVal: Scope;
      try {
        scopeVal = parseScope(options.scope);
      } catch (err) {
        handleCommandError(err);
      }

      // Invariant: an explicit `--apply` bypasses the soft-launch valve. The
      // valve's job is to preview a root a few times before the UNATTENDED
      // daemon tick is allowed to delete anything; it was never meant to
      // override a human who typed --apply. Since the valve became per-root
      // (#771), its counter starts at 0 for every repo that predates the
      // marker, so without this bypass the first three `--apply` runs against
      // any existing repo printed "Dry-run mode — no changes made" and removed
      // nothing, at exit 0. The dry-run branch below must NOT set this flag:
      // that is what keeps a brand-new repo previewing before it is reaped.
      const sweepOptions: SweepOptions = {
        execFile,
        repoRoot,
        dryRun: !options.apply,
        maxAgeDaysClean,
        maxAgeDaysDirty,
        scope: scopeVal,
        ...(options.apply === true ? { bypassSoftLaunch: true } : {}),
      };

      let result;
      try {
        result = await runSweep(sweepOptions);
      } catch (err) {
        handleCommandError(new Error(`Sweep failed: ${errorMessage(err)}`));
      }

      if (result.dryRun) {
        console.log(palette.warning(`🔍 Dry-run mode — no changes made.`));
      }

      // Tally per-verdict instead of an arithmetic subtraction. Orphaned-
      // registration candidates aren't in `removed` (git worktree prune is
      // a separate batch call), so the old `candidates - removed - warned`
      // formula inflated the Skipped count.
      const warnCount = result.warnings.filter((w) => w.startsWith('[WARN]')).length;
      const errorCount = result.warnings.filter((w) => w.startsWith('[ERROR]')).length;
      const tallyStr = buildVerdictTallyString(result.candidates);
      console.log(
        `Removed: ${result.removed.length}, Warned: ${warnCount}, Errors: ${errorCount}${tallyStr}`,
      );

      for (const c of result.candidates) {
        const isRemoved = result.removed.includes(c.path);
        const icon = isRemoved ? palette.error('✗') : palette.success('✓');
        console.log(`  ${icon} [${c.verdict.padEnd(22)}] ${c.path}`);
      }

      if (result.warnings.length > 0) {
        console.log('');
        for (const w of result.warnings) {
          if (w.startsWith('[ERROR]')) {
            console.error(palette.error(w));
          } else {
            console.log(palette.warning(w));
          }
        }
      }

      const hasErrors = result.warnings.some((w) => w.startsWith('[ERROR]'));
      if (hasErrors) process.exit(1);
    });
}
