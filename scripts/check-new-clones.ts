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
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Lines added in the diff of `baseRef...HEAD`, keyed by relative path. */
function addedLinesByFile(baseRef: string): Map<string, Set<number>> {
  const raw = execFileSync(
    'git',
    ['diff', '--unified=0', '--diff-filter=ACMR', `${baseRef}...HEAD`],
    { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 },
  );

  const map = new Map<string, Set<number>>();
  let currentFile: string | null = null;

  for (const line of raw.split('\n')) {
    // +++ b/src/foo.ts
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6);
      continue;
    }
    // @@ -old,count +new,count @@
    if (line.startsWith('@@') && currentFile) {
      const m = line.match(/\+(\d+)(?:,(\d+))?/);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] !== undefined ? Number(m[2]) : 1;
      let set = map.get(currentFile);
      if (!set) {
        set = new Set();
        map.set(currentFile, set);
      }
      for (let i = start; i < start + count; i++) {
        set.add(i);
      }
    }
  }
  return map;
}

interface CloneFile {
  name: string;
  start: number;
  end: number;
  startLoc: { line: number };
  endLoc: { line: number };
}

interface Clone {
  firstFile: CloneFile;
  secondFile: CloneFile;
  isNew: boolean;
  lines: number;
  tokens: number;
}

/** Check whether a clone fragment overlaps any added line in the diff. */
function fragmentOverlapsAdded(
  frag: CloneFile,
  added: Map<string, Set<number>>,
): boolean {
  const lines = added.get(frag.name);
  if (!lines) return false;
  const startLine = frag.startLoc.line;
  const endLine = frag.endLoc.line;
  for (let l = startLine; l <= endLine; l++) {
    if (lines.has(l)) return true;
  }
  return false;
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
