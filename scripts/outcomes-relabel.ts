/**
 * outcomes-relabel.ts — nightly delayed-relabel entrypoint.
 *
 * Scans the outcome store for provisional records, runs delayed LFs (pr_fate,
 * commit_survival, fix_of_fix, ci), upserts votes, and marks records settled
 * when all probes have resolved or settles_after has passed.
 *
 * Usage:
 *   npx tsx scripts/outcomes-relabel.ts [--dry-run] [--limit N] [--rescore-settled]
 *
 * Flags:
 *   --dry-run           run probes but do not write any changes; print what would happen
 *   --limit N           process at most N records (default: 200)
 *   --rescore-settled   OPT-IN: re-apply combiner v2 to settled records whose label
 *                       is 'unknown', using the votes already stored. Preserves history.
 *                       SAFE: only re-combines; never runs remote probes. Intended for
 *                       backfilling the 564 'unknown' records produced by combiner v1.
 *                       Does NOT run against ~/.afk automatically — pass --outcomes-dir
 *                       to target a fixture directory during testing.
 *   --outcomes-dir DIR  override the outcomes directory (for testing only)
 *
 * Exit codes: 0 success, 1 fatal error (e.g. import failure).
 *
 * Schedule (daemon shell task — do NOT create the schedule from code):
 *   name:      "Nightly outcome relabel"
 *   cron:      "17 3 * * *"
 *   executor:  shell
 *   command:   "npx tsx /path/to/repo/scripts/outcomes-relabel.ts"
 *   cwd:       /path/to/repo
 *   notifyOn:  failure
 *
 * See docs/proposals/verified-outcome.md § "M2 status: relabel job" for the
 * exact create_schedule parameters.
 */

import { runRelabelJob, rescoreSettledUnknown } from '../src/agent/outcomes/relabel-job.js';
import { errorMessage } from '../src/utils/errors.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  dryRun: boolean;
  limit: number;
  rescoreSettled: boolean;
  outcomesDir: string | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  let dryRun = false;
  let limit = 200;
  let rescoreSettled = false;
  let outcomesDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--rescore-settled') {
      rescoreSettled = true;
    } else if (arg === '--limit') {
      const next = argv[i + 1];
      if (next !== undefined) {
        const n = parseInt(next, 10);
        if (!Number.isNaN(n) && n > 0) {
          limit = n;
          i++;
        }
      }
    } else if (arg === '--outcomes-dir') {
      const next = argv[i + 1];
      if (next !== undefined) {
        outcomesDir = next;
        i++;
      }
    }
  }

  return { dryRun, limit, rescoreSettled, outcomesDir };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { dryRun, limit, rescoreSettled, outcomesDir } = parseArgs(process.argv.slice(2));

  if (dryRun) {
    process.stdout.write('outcomes-relabel: dry-run mode — no writes\n');
  }

  if (rescoreSettled) {
    // Backfill path: re-apply combiner v2 to settled unknown records
    process.stdout.write('outcomes-relabel: --rescore-settled active — backfilling settled unknown records\n');
    const rescoreResult = await rescoreSettledUnknown({ dryRun, limit, outcomesDir });
    const prefix = dryRun ? '[dry-run] ' : '';
    process.stdout.write(
      `${prefix}outcomes-relabel rescore: scanned=${rescoreResult.scanned} relabeled=${rescoreResult.relabeled} skipped=${rescoreResult.skipped} errors=${rescoreResult.errors}\n`,
    );
    return;
  }

  const result = await runRelabelJob({ dryRun, limit, outcomesDir });

  const prefix = dryRun ? '[dry-run] ' : '';
  process.stdout.write(
    `${prefix}outcomes-relabel: scanned=${result.scanned} settled=${result.settled} updated=${result.updated} skipped=${result.skipped} errors=${result.errors}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `outcomes-relabel: fatal error: ${errorMessage(err)}\n`,
  );
  process.exitCode = 1;
});
