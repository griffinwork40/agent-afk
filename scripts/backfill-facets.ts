/**
 * Batch-derive facets for all persisted sessions that don't have one yet.
 *
 * Usage:
 *   npx tsx scripts/backfill-facets.ts [--dry-run] [--force]
 *
 * --dry-run  Count sessions needing derivation without writing anything.
 * --force    Re-derive even when a fresh cache entry exists.
 *
 * Exit codes:
 *   0  All sessions processed (or dry-run complete).
 *   1  Unexpected error.
 */

import { existsSync, readdirSync } from 'fs';
import { basename, join } from 'path';
import { getOrDeriveFacet, listSessionIds } from '../src/agent/facets/store.js';
import { getFacetCacheDir } from '../src/paths.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

const sessionIds = listSessionIds();
const cacheDir = getFacetCacheDir();

// Determine which sessions already have cached facets.
const cachedIds = new Set<string>();
if (existsSync(cacheDir)) {
  for (const f of readdirSync(cacheDir)) {
    if (f.endsWith('.json')) cachedIds.add(basename(f, '.json'));
  }
}

const needDerivation = force ? sessionIds : sessionIds.filter((id) => !cachedIds.has(id));

console.log(`Total sessions:       ${sessionIds.length}`);
console.log(`Already cached:       ${cachedIds.size}`);
console.log(`Needing derivation:   ${needDerivation.length}`);

if (dryRun) {
  console.log('(dry-run — no facets written)');
  process.exit(0);
}

let derived = 0;
let skipped = 0;
let failed = 0;

for (const id of needDerivation) {
  try {
    const facet = getOrDeriveFacet(id, { force });
    if (facet) {
      derived++;
    } else {
      // Session file missing or unparseable — loadStoredSession returned undefined.
      skipped++;
    }
  } catch {
    failed++;
  }

  // Progress every 500 sessions.
  const total = derived + skipped + failed;
  if (total % 500 === 0 && total > 0) {
    console.log(`  … ${total}/${needDerivation.length} processed`);
  }
}

console.log(`\nDone.`);
console.log(`  Derived: ${derived}`);
console.log(`  Skipped: ${skipped} (missing or unparseable session file)`);
console.log(`  Failed:  ${failed} (derivation error)`);
