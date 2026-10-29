#!/usr/bin/env tsx
/**
 * Clone-gate CI script: fail only on NEW clones that overlap lines ADDED in
 * this PR's diff.
 *
 * Why not `jscpd --baseline-from-ref --fail-on-new-clones 0` directly?
 * Fingerprints are content-keyed. Editing both halves of an existing
 * grandfathered clone pair identically produces a fingerprint absent from the
 * baseline — a false positive. This wrapper filters jscpd's "new clone" list
 * against the PR diff so only genuinely new duplication fails the gate.
 *
 * Usage (CI):
 *   pnpm audit:clones:check            # runs this script
 *
 * Requires `origin/main` (or the PR base ref) to be fetchable.
 *
 * Shallow-clone handling: on CI the checkout is depth=1. `git diff
 * baseRef...HEAD` (three-dot) requires a merge-base commit that may not exist
 * in the shallow history. When `git merge-base` fails, this script falls back
 * to two-dot `git diff baseRef HEAD`. On pull_request CI, HEAD is the
 * synthetic merge commit whose first parent is the base tip, so two-dot and
 * three-dot are equivalent for the added-lines set.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasMergeBase, parseDiffOutput, fragmentOverlapsAdded, CloneFile } from './lib/clone-gate.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface Clone {
  firstFile: CloneFile;
  secondFile: CloneFile;
  isNew: boolean;
  lines: number;
  tokens: number;
}

/**
 * Lines added in the diff of this PR, keyed by relative path.
 *
 * Uses three-dot diff (`baseRef...HEAD`) when a merge-base exists, which
 * isolates exactly the PR's own commits. Falls back to two-dot diff
 * (`baseRef HEAD`) on shallow clones where the merge-base commit is absent;
 * on pull_request CI this is equivalent because HEAD is the synthetic merge
 * commit whose first parent is the base tip.
 */
function addedLinesByFile(baseRef: string): Map<string, Set<number>> {
  const threeDot = hasMergeBase(baseRef);
  const diffArgs = threeDot
    ? ['diff', '--unified=0', '--diff-filter=ACMR', `${baseRef}...HEAD`]
    : ['diff', '--unified=0', '--diff-filter=ACMR', baseRef, 'HEAD'];

  if (!threeDot) {
    console.log(
      `[clone-gate] shallow checkout: no merge base for ${baseRef}; ` +
        `using two-dot diff (${baseRef} HEAD) — equivalent on pull_request CI.`,
    );
  }

  const raw = execFileSync('git', diffArgs, {
    encoding: 'utf-8',
    maxBuffer: 50 * 1024 * 1024,
  });

  const parsed = parseDiffOutput(raw);
  if (parsed.size === 0) {
    console.log('[clone-gate] diff has no added lines — overlap filter will pass all new clones through as genuine.');
  }
  return parsed;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const baseRef = process.env['CLONE_GATE_BASE_REF'] ?? 'origin/main';

  // Run jscpd with JSON reporter into a temp dir.
  const outDir = mkdtempSync(join(tmpdir(), 'afk-clone-gate-'));
  try {
    execFileSync(
      'pnpm',
      [
        'exec', 'jscpd',
        '--config', '.jscpd.json',
        '--baseline-from-ref', baseRef,
        '--reporters', 'json,console',
        '--output', outDir,
      ],
      { encoding: 'utf-8', stdio: ['pipe', 'inherit', 'inherit'] },
    );

    const reportPath = join(outDir, 'jscpd-report.json');
    if (!existsSync(reportPath)) {
      console.error('check-new-clones: jscpd did not produce a JSON report');
      process.exit(1);
    }

    const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as {
      duplicates: Clone[];
    };

    const newClones = report.duplicates.filter((c) => c.isNew);
    if (newClones.length === 0) {
      console.log('✓ No new clones detected.');
      return;
    }

    // Filter: keep only clones where at least one fragment overlaps added lines.
    const added = addedLinesByFile(baseRef);
    const genuine: Clone[] = [];

    for (const clone of newClones) {
      if (
        fragmentOverlapsAdded(clone.firstFile, added) ||
        fragmentOverlapsAdded(clone.secondFile, added)
      ) {
        genuine.push(clone);
      }
    }

    if (genuine.length === 0) {
      console.log(
        `✓ ${newClones.length} new fingerprint(s) from synchronized edits to existing clones — not genuine new duplication.`,
      );
      return;
    }

    console.error(
      `✗ ${genuine.length} genuine new clone(s) (overlapping lines added in this PR):`,
    );
    for (const c of genuine) {
      console.error(
        `  ${c.firstFile.name}:${c.firstFile.startLoc.line}-${c.firstFile.endLoc.line}` +
          ` ↔ ${c.secondFile.name}:${c.secondFile.startLoc.line}-${c.secondFile.endLoc.line}` +
          ` (${c.lines} lines, ${c.tokens} tokens)`,
      );
    }
    console.error(
      '\nWrap intentional duplication in `// jscpd:ignore-start` / `// jscpd:ignore-end` with a reason comment.',
    );
    process.exit(1);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

main();
