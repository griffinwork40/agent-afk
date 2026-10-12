/**
 * `afk branch` command group.
 *
 * Subcommands:
 *   afk branch prune  — list and optionally delete stale remote `afk/*` branches
 *
 * Safety: defaults to --dry-run. The --execute flag is required for actual
 * remote deletions. `git push --delete` only removes the remote ref; local
 * branches and reflog entries survive.
 *
 * @module cli/commands/branch
 */

import { Command } from 'commander';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { handleCommandError } from '../errors/index.js';
import { palette } from '../palette.js';
import { printWarnings } from './print-warnings.js';
import { errorMessage } from '../../utils/errors.js';
import { resolveRepoRoot } from '../../utils/git.js';
import { runBranchPrune } from '../../agent/branch/branch-prune.js';
import type { ExecForBranchPrune, BranchCandidate } from '../../agent/branch/branch-prune.js';

const execFile = promisify(execFileCallback) as ExecForBranchPrune;

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function verdictIcon(candidate: BranchCandidate): string {
  switch (candidate.verdict) {
    case 'prune': return palette.error('✗');
    case 'keep':  return palette.success('✓');
    case 'error': return palette.warning('⚠');
  }
}

function verdictLabel(candidate: BranchCandidate): string {
  switch (candidate.verdict) {
    case 'prune': return 'PRUNE';
    case 'keep':  return 'KEEP ';
    case 'error': return 'ERROR';
  }
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerBranchCommand(program: Command): void {
  const branch = program
    .command('branch')
    .description('Manage remote branches created by afk worktrees');

  // ── afk branch prune ───────────────────────────────────────────────────
  branch
    .command('prune')
    .description(
      'List (and optionally delete) stale remote afk/* branches whose PRs are closed/merged',
    )
    .option(
      '--execute',
      'Actually delete branches (default is dry-run — prints what would be pruned)',
      false,
    )
    .option('--remote <name>', 'Remote to operate on', 'origin')
    .option('--base <branch>', 'Base branch for commit-ahead comparison', 'main')
    .option('--prefix <prefix>', 'Branch prefix to filter on', 'afk/')
    .action(async (options: {
      execute: boolean;
      remote: string;
      base: string;
      prefix: string;
    }) => {
      const dryRun = !options.execute;

      let repoRoot: string;
      try {
        repoRoot = await resolveRepoRoot();
      } catch (err) {
        handleCommandError(err);
      }

      if (dryRun) {
        console.log(palette.warning('🔍 Dry-run mode — no branches will be deleted.'));
        console.log(palette.dim('   Pass --execute to actually prune.\n'));
      }

      let result;
      try {
        result = await runBranchPrune({
          execFn: execFile,
          remote: options.remote,
          baseBranch: options.base,
          branchPrefix: options.prefix,
          dryRun,
          cwd: repoRoot,
        });
      } catch (err) {
        handleCommandError(new Error(`Branch prune failed: ${errorMessage(err)}`));
      }

      if (result.candidates.length === 0) {
        console.log(palette.dim(`  (no remote branches matching "${options.prefix}*" found on ${options.remote})`));
        return;
      }

      // Print table header
      const header = [
        'VERDICT'.padEnd(6),
        'BRANCH'.padEnd(55),
        'PR'.padEnd(7),
        'AHEAD'.padEnd(6),
        'REASON',
      ].join(' | ');
      console.log(palette.heading(header));
      console.log('-'.repeat(Math.min(header.length, 120)));

      for (const c of result.candidates) {
        const row = [
          verdictLabel(c).padEnd(6),
          c.shortName.slice(-54).padEnd(55),
          c.prState.padEnd(7),
          String(c.commitsAhead).padEnd(6),
          c.reason,
        ].join(' | ');
        console.log(`${verdictIcon(c)} ${row}`);
      }

      console.log('');

      const pruneCount = result.candidates.filter((c) => c.verdict === 'prune').length;
      const keepCount  = result.candidates.filter((c) => c.verdict === 'keep').length;
      const errorCount = result.candidates.filter((c) => c.verdict === 'error').length;

      if (dryRun) {
        console.log(
          `Would prune: ${pruneCount}, Would keep: ${keepCount}` +
          (errorCount > 0 ? `, Errors: ${errorCount}` : ''),
        );
        if (pruneCount > 0) {
          console.log(palette.dim('\nRun with --execute to actually delete these branches.'));
        }
      } else {
        console.log(
          `Deleted: ${result.deleted.length}, Kept: ${keepCount}` +
          (errorCount > 0 ? `, Errors: ${errorCount}` : ''),
        );
      }

      const hasErrors = printWarnings(result.warnings);
      if (hasErrors) process.exit(1);
    });
}
