/**
 * outcomes-relabel.ts — nightly delayed-relabel entrypoint.
 *
 * Scans the outcome store for provisional records, runs delayed LFs (pr_fate,
 * commit_survival, fix_of_fix, ci), upserts votes, and marks records settled
 * when all probes have resolved or settles_after has passed.
 *
 * Usage:
 *   npx tsx scripts/outcomes-relabel.ts [--dry-run] [--limit N]
 *
 * Flags:
 *   --dry-run    run probes but do not write any changes; print what would happen
 *   --limit N    process at most N provisional records (default: 200)
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

import { runRelabelJob } from '../src/agent/outcomes/relabel-job.js';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { dryRun: boolean; limit: number } {
  let dryRun = false;
  let limit = 200;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--limit') {
      const next = argv[i + 1];
      if (next !== undefined) {
        const n = parseInt(next, 10);
        if (!Number.isNaN(n) && n > 0) {
          limit = n;
          i++;
        }
      }
    }
  }

  return { dryRun, limit };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { dryRun, limit } = parseArgs(process.argv.slice(2));

  if (dryRun) {
    process.stdout.write('outcomes-relabel: dry-run mode — no writes\n');
  }

  const result = await runRelabelJob({ dryRun, limit });

  const prefix = dryRun ? '[dry-run] ' : '';
  process.stdout.write(
    `${prefix}outcomes-relabel: scanned=${result.scanned} settled=${result.settled} updated=${result.updated} skipped=${result.skipped} errors=${result.errors}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `outcomes-relabel: fatal error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});
