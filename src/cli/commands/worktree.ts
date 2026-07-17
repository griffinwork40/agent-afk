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
import { runSweep } from '../../agent/worktree-sweep.js';
import type { SweepOptions } from '../../agent/worktree-sweep.js';
import { loadConfig } from '../config.js';
import type { ExecFileFn } from '../../agent/worktree-sweep.js';

const execFile = promisify(execFileCallback) as ExecFileFn;

async function resolveRepoRoot(): Promise<string> {
  try {
    const result = await execFile('git', ['rev-parse', '--show-toplevel']);
    return result.stdout.trim();
  } catch {
    throw new Error('Not in a git repository.');
  }
}

function verdictWouldPrune(v: string): string {
  // 'stale-clean' is preserved + warned by the sweep engine (commits ahead
  // of base), so it renders as 'warn' alongside 'stale-dirty'.
  if (['empty', 'orphaned-dir', 'orphaned-registration', 'dead-owner'].includes(v)) {
    return palette.error('yes');
  }
  if (v === 'stale-dirty' || v === 'stale-clean') return palette.warning('warn');
  return palette.success('no');
}

const VALID_SCOPES = ['interactive', 'diagnose', 'all'] as const;
type Scope = (typeof VALID_SCOPES)[number];

function parseScope(raw: string): Scope {
  if ((VALID_SCOPES as readonly string[]).includes(raw)) return raw as Scope;
  throw new Error(
    `Invalid --scope value: '${raw}'. Allowed: ${VALID_SCOPES.join(' | ')}.`,
  );
}

function formatAgeDays(ageMs: number): string {
  if (ageMs <= 0) return '-';
  const days = ageMs / 86_400_000;
  if (days < 1) {
    const hours = Math.max(1, Math.round(ageMs / 3_600_000));
    return `${hours}h`;
  }
  return `${Math.round(days)}d`;
}

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
        handleCommandError(new Error(`Sweep failed: ${(err as Error).message}`));
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
          formatAgeDays(c.ageMs).padEnd(6),
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

      const sweepOptions: SweepOptions = {
        execFile,
        repoRoot,
        dryRun: !options.apply,
        maxAgeDaysClean,
        maxAgeDaysDirty,
        scope: scopeVal,
      };

      let result;
      try {
        result = await runSweep(sweepOptions);
      } catch (err) {
        handleCommandError(new Error(`Sweep failed: ${(err as Error).message}`));
      }

      if (result.dryRun) {
        console.log(palette.warning(`🔍 Dry-run mode — no changes made.`));
      }

      // Tally per-verdict instead of an arithmetic subtraction. Orphaned-
      // registration candidates aren't in `removed` (git worktree prune is
      // a separate batch call), so the old `candidates - removed - warned`
      // formula inflated the Skipped count.
      const verdictTally: Record<string, number> = {};
      for (const c of result.candidates) {
        verdictTally[c.verdict] = (verdictTally[c.verdict] ?? 0) + 1;
      }
      const warnCount = result.warnings.filter((w) => w.startsWith('[WARN]')).length;
      const errorCount = result.warnings.filter((w) => w.startsWith('[ERROR]')).length;
      const tallyParts = Object.entries(verdictTally)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([v, n]) => `${v}=${n}`);
      console.log(
        `Removed: ${result.removed.length}, Warned: ${warnCount}, Errors: ${errorCount}` +
          (tallyParts.length > 0 ? `  [${tallyParts.join(' ')}]` : ''),
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
